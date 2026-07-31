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
import { useAsync } from '../hooks/useAsync.js';
import { useLive } from '../hooks/useLive.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';

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

  const sessionState = useAsync((signal) => getSession(sessionId, signal), [sessionId]);
  const paymentsState = useAsync((signal) => getPayments(sessionId, signal), [sessionId]);

  const { reload: reloadPayments, set: setPayments } = paymentsState;

  // Payment events carry enough to patch a single row, which keeps a dashboard
  // that ten people have open from issuing ten refetches per confirmation.
  const patch = useCallback(
    (memberId: string, change: Partial<Payment>) => {
      setPayments((current: PaymentSummary | null) => {
        if (!current) return current;
        const payments = current.payments.map((p) =>
          p.memberId === memberId ? { ...p, ...change } : p,
        );
        return { ...current, ...recomputeTotals(payments), payments };
      });
    },
    [setPayments],
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
          sessionState.reload();
          return;
        default:
          return;
      }
    },
  });

  const session = sessionState.data?.session ?? null;
  const summary = paymentsState.data;

  if (!session || !summary) {
    if (sessionState.error || paymentsState.error) {
      return <ErrorBanner>{sessionState.error ?? paymentsState.error}</ErrorBanner>;
    }
    return <Spinner label="Loading payments…" />;
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
              sessionState.reload();
            }}
          />
        ) : (
          <div className="card">
            <h2 className="card-title">Not split yet</h2>
            <p className="card-sub">
              The organizer has not entered the field charge for this session yet.
            </p>
          </div>
        )
      ) : (
        <>
          <div className="card">
            <div className="row between">
              <h2 className="card-title">Field total</h2>
              <span className="amount">{formatVnd(summary.totalCharge ?? 0)}</span>
            </div>
            <div className="row between">
              <span className="muted">Collected</span>
              <span className="amount" style={{ color: 'var(--ff-paid)' }}>
                {formatVnd(summary.collected)}
              </span>
            </div>
            <div className="row between">
              <span className="muted">Still owed</span>
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
                  sessionState.reload();
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
          <h2 className="card-title">Everyone ({summary.payments.length})</h2>
          <span className={`conn ${connection}`}>
            <span className="dot" />
            {connection === 'live' ? 'Live' : connection === 'polling' ? '30s' : 'Paused'}
          </span>
        </div>

        {summary.payments.length === 0 ? (
          <p className="empty">Nothing to split yet.</p>
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
        label="Copy status for chat"
        text={paymentsSummary(session, summary, { appUrl: platform.appUrl })}
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
  const [total, setTotal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = total.trim() ? parseVnd(total) : null;

  const submit = async () => {
    if (parsed === null) {
      setError('Enter the amount the pitch cost, e.g. 560k');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await settleSession(sessionId, { totalCharge: parsed });
      toast('Split between everyone who played');
      onSettled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not split that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">Split the bill</h2>
      <p className="card-sub">
        Enter what the pitch cost in total. It is divided between everyone who was in — not the
        waitlist — and rounded to the nearest 1.000d.
      </p>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <TextField
        label="Total field charge"
        value={total}
        onChange={setTotal}
        inputMode="numeric"
        supportingText={parsed !== null ? formatVnd(parsed) : 'e.g. 560k'}
      />
      <Button onClick={submit} disabled={busy}>
        {busy ? 'Splitting…' : 'Split it'}
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
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(String(current));
  const [busy, setBusy] = useState(false);

  const parsed = parseVnd(total);

  const submit = async () => {
    if (parsed === null) return;
    setBusy(true);
    try {
      await settleSession(sessionId, { totalCharge: parsed });
      toast('Amounts recalculated');
      setOpen(false);
      onSettled();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="text" onClick={() => setOpen(true)}>
        Change total
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline="Change the total"
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || parsed === null}>
              Save
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          Everyone's share is recalculated. Amounts you pinned by hand stay pinned, and payments
          already confirmed stay confirmed.
        </p>
        <TextField
          label="Total field charge"
          value={total}
          onChange={setTotal}
          inputMode="numeric"
          supportingText={parsed !== null ? formatVnd(parsed) : 'e.g. 560k'}
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
      onToast('Marked as paid — waiting for confirmation');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not mark that');
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
      setError(cause instanceof Error ? cause.message : 'Could not undo that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">You owe</h2>
        <span className="amount" style={{ fontSize: '1.3rem' }}>
          {formatVnd(payment.amountDue)}
        </span>
      </div>

      {payment.rejectReason ? (
        <ErrorBanner>Rejected: {payment.rejectReason}</ErrorBanner>
      ) : null}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {payment.status === 'confirmed' ? (
        <div className="row" style={{ gap: 8, color: 'var(--ff-paid)' }}>
          <Icon name="check" size={20} />
          <strong>Paid and confirmed. Thanks.</strong>
        </div>
      ) : payment.status === 'pending' ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={20} />
            <span>Waiting for the organizer to confirm.</span>
          </div>
          <Button variant="text" onClick={undo} disabled={busy}>
            That was a mistake — undo
          </Button>
        </>
      ) : (
        <div className="stack">
          <Button onClick={() => claim(true)} disabled={busy}>
            <Icon name="camera" size={18} slot="icon" />
            {busy ? 'Working…' : 'I paid — attach screenshot'}
          </Button>
          <Button variant="outlined" onClick={() => claim(false)} disabled={busy}>
            I paid, no screenshot
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
  const [busy, setBusy] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [amount, setAmount] = useState(String(payment.amountDue));

  const review = async (decision: 'confirm' | 'reject') => {
    setBusy(true);
    try {
      const reason = decision === 'reject' ? 'Amount did not match' : undefined;
      await reviewPayment(payment.id, { decision, reason });
      toast(decision === 'confirm' ? `${payment.memberName} confirmed` : `${payment.memberName} rejected`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const saveOverride = async (value: number | null) => {
    setBusy(true);
    try {
      await overridePayment(payment.id, value);
      toast('Amounts rebalanced');
      setEditingAmount(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="player-row" style={{ flexWrap: 'wrap' }}>
      <span className="player-name truncate">{payment.memberName}</span>

      <span className="amount">{formatVnd(payment.amountDue)}</span>
      {payment.amountOverride != null ? <span className="badge waitlist">fixed</span> : null}

      <span className={`badge ${payment.status === 'confirmed' ? 'paid' : payment.status}`}>
        {payment.status === 'confirmed' ? 'paid' : payment.status === 'pending' ? 'checking' : 'unpaid'}
      </span>

      {canReview ? (
        <div className="row wrap" style={{ width: '100%', gap: 4, justifyContent: 'flex-end' }}>
          {payment.hasProof ? (
            <Button variant="text" onClick={() => setShowProof(true)}>
              Screenshot
            </Button>
          ) : null}
          <Button variant="text" onClick={() => setEditingAmount(true)}>
            Amount
          </Button>
          {payment.status !== 'confirmed' ? (
            <Button variant="tonal" onClick={() => review('confirm')} disabled={busy}>
              Confirm
            </Button>
          ) : null}
          {payment.status === 'pending' ? (
            <Button variant="text" onClick={() => review('reject')} disabled={busy}>
              Reject
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
        headline={`${payment.memberName}'s share`}
        actions={
          <>
            <Button variant="text" onClick={() => saveOverride(null)} disabled={busy}>
              Back to equal split
            </Button>
            <Button
              onClick={() => {
                const parsed = parseVnd(amount);
                if (parsed !== null) void saveOverride(parsed);
              }}
              disabled={busy}
            >
              Save
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          Pin an amount for {payment.memberName}. Everyone else splits what is left.
        </p>
        <TextField label="Amount" value={amount} onChange={setAmount} inputMode="numeric" />
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
