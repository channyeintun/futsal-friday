import {
  type Payment,
  type PaymentSummary,
  formatVnd,
  parseVnd,
  paymentsSummary,
  sessionChannel,
} from '@futsal/shared';
import { useCallback, useState } from 'react';
import {
  claimPayment,
  getPayments,
  overridePayment,
  reviewPayment,
  settleSession,
  unclaimPayment,
  uploadProof,
} from '../api/payments.js';
import { getSession } from '../api/sessions.js';
import { CopyButton } from '../components/CopyButton.js';
import { Icon } from '../components/Icon.js';
import { ProofViewer } from '../components/ProofViewer.js';
import { Button, Dialog, ErrorBanner, Spinner, TextField } from '../components/ui.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, usePayments, useSession } from '../hooks/queries.js';
import { useLive } from '../hooks/useLive.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale, useMessages } from '../state/locale.js';

/**
 * The money screen.
 *
 * Members see what they owe and a button to claim they have paid; the organizer
 * sees the same list plus the controls to split the bill, adjust an amount, and
 * confirm or reject each claim. Everyone sees everyone — chasing a payment is
 * much easier when the list is public.
 */
export function PaymentsPage({ sessionId }: { sessionId: string }) {
  const { identity, toast } = useApp();
  const { m, locale } = useLocale();

  const queryClient = useQueryClient();
  const sessionState = useSession(sessionId);
  const paymentsState = usePayments(sessionId);

  const reloadPayments = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.payments(sessionId) });
  }, [queryClient, sessionId]);

  // Payment events carry enough to patch a single row, which keeps a dashboard
  // that ten people have open from issuing ten refetches per confirmation.
  // Patching the cache rather than component state means the update is still
  // there after a trip to another screen and back.
  const patch = useCallback(
    (memberId: string, change: Partial<Payment>) => {
      queryClient.setQueryData<PaymentSummary>(queryKeys.payments(sessionId), (current) => {
        if (!current) return current;
        const payments = current.payments.map((p) =>
          p.memberId === memberId ? { ...p, ...change } : p,
        );
        return { ...current, ...recomputeTotals(payments), payments };
      });
    },
    [queryClient, sessionId],
  );

  const connection = useLive([sessionChannel(sessionId)], {
    onRefresh: reloadPayments,
    onEvent: (event) => {
      switch (event.name) {
        case 'payment.claimed':
          patch(event.data.memberId, { status: 'pending', hasProof: event.data.hasProof });
          return;
        case 'payment.confirmed':
          patch(event.data.memberId, { status: 'confirmed' });
          return;
        case 'payment.rejected':
          patch(event.data.memberId, { status: 'unpaid', rejectReason: event.data.reason });
          return;
        case 'session.updated':
          // A re-split changes every amount at once.
          reloadPayments();
          void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
          return;
        default:
          return;
      }
    },
  });

  const session = sessionState.data?.session ?? null;
  const summary = paymentsState.data;

  if (!session || !summary) {
    const failure = sessionState.error ?? paymentsState.error;
    if (failure) return <ErrorBanner>{failure.message}</ErrorBanner>;
    return <Spinner label={m.payments.loading} />;
  }

  const mine = summary.payments.find((p) => p.memberId === identity.memberId) ?? null;

  return (
    <>
      {session.totalCharge == null ? (
        identity.isOrganizer ? (
          <SettleCard
            sessionId={sessionId}
            onSettled={() => {
              reloadPayments();
              void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
            }}
          />
        ) : (
          <div className="card">
            <h2 className="card-title">{m.payments.notSplitYet}</h2>
            <p className="card-sub">{m.payments.notSplitYetBody}</p>
          </div>
        )
      ) : (
        <>
          <div className="card">
            <div className="row between">
              <h2 className="card-title">{m.payments.fieldTotal}</h2>
              <span className="amount">{formatVnd(summary.totalCharge ?? 0)}</span>
            </div>
            <div className="row between">
              <span className="muted">{m.payments.collected}</span>
              <span className="amount" style={{ color: 'var(--ff-paid)' }}>
                {formatVnd(summary.collected)}
              </span>
            </div>
            <div className="row between">
              <span className="muted">{m.payments.stillOwed}</span>
              <span className="amount" style={{ color: 'var(--md-sys-color-error)' }}>
                {formatVnd(summary.outstanding)}
              </span>
            </div>
            {identity.isOrganizer ? (
              <ReSettleButton
                sessionId={sessionId}
                current={summary.totalCharge ?? 0}
                onSettled={() => {
                  reloadPayments();
                  void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
                }}
              />
            ) : null}
          </div>

          {mine ? (
            <MyPayment
              sessionId={sessionId}
              payment={mine}
              onChanged={reloadPayments}
              onToast={toast}
            />
          ) : null}
        </>
      )}

      <div className="card">
        <div className="row between">
          <h2 className="card-title">{m.payments.everyone(summary.payments.length)}</h2>
          <span className={`conn ${connection}`}>
            <span className="dot" />
            {connection === 'live'
              ? m.connection.live
              : connection === 'polling'
                ? m.connection.pollingShort
                : m.connection.idle}
          </span>
        </div>

        {summary.payments.length === 0 ? (
          <p className="empty">{m.payments.nothingToSplit}</p>
        ) : (
          summary.payments.map((payment) => (
            <PaymentRow
              key={payment.id}
              payment={payment}
              canReview={identity.isOrganizer}
              onChanged={reloadPayments}
            />
          ))
        )}
      </div>

      <CopyButton
        label={m.payments.copyStatus}
        text={paymentsSummary(session, summary, { appUrl: platform.appUrl, locale })}
      />
    </>
  );
}

/* ----------------------------------------------------------------- settle */

function SettleCard({
  sessionId,
  onSettled,
}: {
  sessionId: string;
  onSettled(): void;
}) {
  const { toast } = useApp();
  const m = useMessages();
  const [total, setTotal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = total.trim() ? parseVnd(total) : null;

  const submit = async () => {
    if (parsed === null) {
      setError(m.payments.enterAmount);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await settleSession(sessionId, { totalCharge: parsed });
      toast(m.toast.splitDone);
      onSettled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.payments.couldNotSplit);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">{m.payments.splitTitle}</h2>
      <p className="card-sub">{m.payments.splitBody}</p>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <TextField
        label={m.payments.totalCharge}
        value={total}
        onChange={setTotal}
        inputMode="numeric"
        supportingText={parsed !== null ? formatVnd(parsed) : m.payments.enterAmount}
      />
      <Button onClick={submit} disabled={busy}>
        {busy ? m.payments.splitting : m.payments.splitIt}
      </Button>
    </div>
  );
}

function ReSettleButton({
  sessionId,
  current,
  onSettled,
}: {
  sessionId: string;
  current: number;
  onSettled(): void;
}) {
  const { toast } = useApp();
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(String(current));
  const [busy, setBusy] = useState(false);

  const parsed = parseVnd(total);

  const submit = async () => {
    if (parsed === null) return;
    setBusy(true);
    try {
      await settleSession(sessionId, { totalCharge: parsed });
      toast(m.toast.amountsRecalculated);
      setOpen(false);
      onSettled();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="text" onClick={() => setOpen(true)}>
        {m.payments.changeTotal}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={m.payments.changeTotalTitle}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={submit} disabled={busy || parsed === null}>
              {m.app.save}
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.payments.changeTotalBody}
        </p>
        <TextField
          label={m.payments.totalCharge}
          value={total}
          onChange={setTotal}
          inputMode="numeric"
          supportingText={parsed !== null ? formatVnd(parsed) : m.payments.enterAmount}
        />
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------- my payment */

function MyPayment({
  sessionId,
  payment,
  onChanged,
  onToast,
}: {
  sessionId: string;
  payment: Payment;
  onChanged(): void;
  onToast(message: string): void;
}) {
  const m = useMessages();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async (withProof: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let proofKey: string | null = null;
      if (withProof) {
        const file = await platform.pickImage();
        if (!file) {
          setBusy(false);
          return;
        }
        proofKey = await uploadProof(sessionId, file);
      }
      await claimPayment(sessionId, { proofKey });
      onToast(m.toast.markedPaid);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.payments.couldNotMark);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    try {
      await unclaimPayment(sessionId);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.payments.couldNotUndo);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.payments.youOwe}</h2>
        <span className="amount" style={{ fontSize: '1.3rem' }}>
          {formatVnd(payment.amountDue)}
        </span>
      </div>

      {payment.rejectReason ? (
        <ErrorBanner>{m.payments.rejectedWithReason(payment.rejectReason)}</ErrorBanner>
      ) : null}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {payment.status === 'confirmed' ? (
        <div className="row" style={{ gap: 8, color: 'var(--ff-paid)' }}>
          <Icon name="check" size={20} />
          <strong>{m.payments.paidConfirmed}</strong>
        </div>
      ) : payment.status === 'pending' ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={20} />
            <span>{m.payments.waitingConfirm}</span>
          </div>
          <Button variant="text" onClick={undo} disabled={busy}>
            {m.payments.undoClaim}
          </Button>
        </>
      ) : (
        <div className="stack">
          <Button onClick={() => claim(true)} disabled={busy}>
            <Icon name="camera" size={18} slot="icon" />
            {busy ? m.app.working : m.payments.paidWithShot}
          </Button>
          <Button variant="outlined" onClick={() => claim(false)} disabled={busy}>
            {m.payments.paidNoShot}
          </Button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- one person */

function PaymentRow({
  payment,
  canReview,
  onChanged,
}: {
  payment: Payment;
  canReview: boolean;
  onChanged(): void;
}) {
  const { toast } = useApp();
  const m = useMessages();
  const [busy, setBusy] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [amount, setAmount] = useState(String(payment.amountDue));

  const review = async (decision: 'confirm' | 'reject') => {
    setBusy(true);
    try {
      const reason = decision === 'reject' ? m.payments.rejectReason : undefined;
      await reviewPayment(payment.id, { decision, reason });
      toast(
        decision === 'confirm'
          ? m.toast.confirmed(payment.memberName)
          : m.toast.rejected(payment.memberName),
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const saveOverride = async (value: number | null) => {
    setBusy(true);
    try {
      await overridePayment(payment.id, value);
      toast(m.toast.amountsRebalanced);
      setEditingAmount(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="player-row" style={{ flexWrap: 'wrap' }}>
      <span className="player-name truncate">
        {payment.memberName}
        {/* Why this person owes more than the others. Read from the payment,
            not from the live registration: the charge records its own basis. */}
        {payment.guests > 0 ? (
          <span className="muted"> {m.session.guestChip(payment.guests)}</span>
        ) : null}
      </span>

      <span className="amount">{formatVnd(payment.amountDue)}</span>
      {payment.amountOverride != null ? (
        <span className="badge waitlist">{m.payments.fixed}</span>
      ) : null}

      <span className={`badge ${payment.status === 'confirmed' ? 'paid' : payment.status}`}>
        {payment.status === 'confirmed'
          ? m.payments.statusPaid
          : payment.status === 'pending'
            ? m.payments.statusChecking
            : m.payments.statusUnpaid}
      </span>

      {canReview ? (
        <div className="row wrap" style={{ width: '100%', gap: 4, justifyContent: 'flex-end' }}>
          {payment.hasProof ? (
            <Button variant="text" onClick={() => setShowProof(true)}>
              {m.payments.screenshot}
            </Button>
          ) : null}
          <Button variant="text" onClick={() => setEditingAmount(true)}>
            {m.payments.amount}
          </Button>
          {payment.status !== 'confirmed' ? (
            <Button variant="tonal" onClick={() => review('confirm')} disabled={busy}>
              {m.payments.confirm}
            </Button>
          ) : null}
          {payment.status === 'pending' ? (
            <Button variant="text" onClick={() => review('reject')} disabled={busy}>
              {m.payments.reject}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showProof ? (
        <ProofViewer
          paymentId={payment.id}
          memberName={payment.memberName}
          onClose={() => setShowProof(false)}
        />
      ) : null}

      <Dialog
        open={editingAmount}
        onClose={() => setEditingAmount(false)}
        headline={m.payments.shareTitle(payment.memberName)}
        actions={
          <>
            <Button variant="text" onClick={() => saveOverride(null)} disabled={busy}>
              {m.payments.backToEqual}
            </Button>
            <Button
              onClick={() => {
                const parsed = parseVnd(amount);
                if (parsed !== null) void saveOverride(parsed);
              }}
              disabled={busy}
            >
              {m.app.save}
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.payments.shareBody(payment.memberName)}
        </p>
        <TextField label={m.payments.amount} value={amount} onChange={setAmount} inputMode="numeric" />
      </Dialog>
    </div>
  );
}

/** Keeps the header totals honest when a row is patched from a live event. */
function recomputeTotals(payments: Payment[]): Pick<
  PaymentSummary,
  'collected' | 'pending' | 'outstanding'
> {
  let collected = 0;
  let pending = 0;
  let outstanding = 0;
  for (const p of payments) {
    if (p.status === 'confirmed') collected += p.amountDue;
    else {
      outstanding += p.amountDue;
      if (p.status === 'pending') pending += p.amountDue;
    }
  }
  return { collected, pending, outstanding };
}
