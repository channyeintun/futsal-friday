import { BANKS, bankByBin } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { clearPaymentDetails, savePaymentDetails } from '../api/payment-details.js';
import { queryKeys, usePaymentDetails } from '../hooks/queries.js';
import { useLocale } from '../state/locale.js';
import { ConfirmButton } from './ConfirmButton.js';
import { PaymentQr } from './PaymentQr.js';
import { Button, Dialog, ErrorBanner, TextField } from './ui.js';

/**
 * The organizer's side: whose account the group pays into.
 *
 * Deliberately group-wide rather than attached to whoever happens to be an
 * organizer, so handing the role to somebody else does not quietly redirect
 * everybody's transfers.
 */
export function PaymentDetailsCard() {
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const details = usePaymentDetails();

  const [editing, setEditing] = useState(false);
  const [bankBin, setBankBin] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = details.data ?? null;

  const open = () => {
    setBankBin(current?.bankBin ?? BANKS[0]!.bin);
    setAccountNumber(current?.accountNumber ?? '');
    setAccountName(current?.accountName ?? '');
    setNote(current?.note ?? '');
    setError(null);
    setEditing(true);
  };

  const settle = () => queryClient.invalidateQueries({ queryKey: queryKeys.paymentDetails });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await savePaymentDetails({
        bankBin,
        bankName: bankByBin(bankBin)?.name ?? '',
        accountNumber: accountNumber.trim(),
        accountName: accountName.trim(),
        note: note.trim() || null,
      });
      setEditing(false);
      await settle();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.pay.couldNotSave);
    } finally {
      setBusy(false);
    }
  };

  if (details.isPending) return null;

  return (
    <div className="card">
      <h2 className="card-title">{m.pay.editTitle}</h2>
      <p className="card-sub">{m.pay.editBody}</p>

      {current ? (
        <>
          <dl className="pay-details">
            <dt>{m.pay.bank}</dt>
            <dd>{current.bankName}</dd>
            <dt>{m.pay.accountNumber}</dt>
            <dd className="pay-account">{current.accountNumber}</dd>
            <dt>{m.pay.accountName}</dt>
            <dd>{current.accountName}</dd>
          </dl>
          {/* Without an amount: this is the organizer checking their own
              details scan, not a bill for anyone. */}
          <PaymentQr
            bankBin={current.bankBin}
            accountNumber={current.accountNumber}
            size={160}
          />
          <Button variant="outlined" onClick={open}>
            {m.pay.edit}
          </Button>
          <ConfirmButton
            headline={m.pay.confirmRemove}
            body={m.pay.confirmRemoveBody}
            confirmLabel={m.pay.remove}
            onConfirm={async () => {
              await clearPaymentDetails();
              await settle();
            }}
          >
            {m.pay.remove}
          </ConfirmButton>
        </>
      ) : (
        <Button variant="outlined" onClick={open}>
          {m.pay.setUp}
        </Button>
      )}

      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        headline={m.pay.editTitle}
        actions={
          <>
            <Button variant="text" onClick={() => setEditing(false)}>
              {m.app.cancel}
            </Button>
            <Button onClick={save} disabled={busy || !accountNumber.trim() || !accountName.trim()}>
              {busy ? m.app.working : m.pay.save}
            </Button>
          </>
        }
      >
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        <label className="pay-bank-picker">
          <span className="muted">{m.pay.pickBank}</span>
          <select value={bankBin} onChange={(event) => setBankBin(event.target.value)}>
            {BANKS.map((bank) => (
              <option key={bank.bin} value={bank.bin}>
                {bank.name}
              </option>
            ))}
          </select>
        </label>

        <TextField
          label={m.pay.accountNumber}
          value={accountNumber}
          onChange={setAccountNumber}
        />
        <TextField label={m.pay.accountName} value={accountName} onChange={setAccountName} />
        <TextField
          label={m.pay.noteLabel}
          value={note}
          onChange={setNote}
          supportingText={m.pay.notePlaceholder}
        />
      </Dialog>
    </div>
  );
}
