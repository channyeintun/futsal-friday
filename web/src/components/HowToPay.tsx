import { formatKickoff, formatVnd, sanitizeReference } from '@futsal/shared';
import { usePaymentDetails } from '../hooks/queries.js';
import { platform } from '../platform/index.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Icon } from './Icon.js';
import { PaymentQr } from './PaymentQr.js';
import { Button } from './ui.js';

/**
 * Where to send the money, and a code with the amount already in it.
 *
 * Shown to whoever still owes something. The account details are in plain text
 * above the code on purpose: the QR is the fast path, but a number you can
 * read and copy is the one that works on every phone, in every banking app,
 * and when somebody is paying from a laptop.
 */
export function HowToPay({
  amount,
  sessionStartsAt,
}: {
  /** What this member owes for this session, in integer dong. */
  amount: number;
  sessionStartsAt: string;
}) {
  const { m } = useLocale();
  const { identity, toast } = useApp();
  const details = usePaymentDetails();

  if (details.isPending || !details.data) return null;
  const d = details.data;

  // What the payer's bank statement will say. Folded to ASCII because
  // Vietnamese banks are unreliable with diacritics in a transfer note.
  const reference = sanitizeReference(
    `${identity.name} ${formatKickoff(sessionStartsAt, 'en')}`,
  );

  const copy = async (text: string, label: string) => {
    if (await platform.clipboard.write(text)) toast(label);
  };

  return (
    <div className="card">
      <h2 className="card-title">{m.pay.title}</h2>
      <p className="card-sub">{m.pay.body}</p>

      <div className="pay-amount">{m.pay.youOweThis(formatVnd(amount))}</div>

      <PaymentQr
        bankBin={d.bankBin}
        accountNumber={d.accountNumber}
        amount={amount}
        reference={reference}
      />

      <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
        {m.pay.scanHint}
      </p>

      <dl className="pay-details">
        <dt>{m.pay.bank}</dt>
        <dd>{d.bankName}</dd>
        <dt>{m.pay.accountNumber}</dt>
        {/* Tabular figures: an account number is read digit by digit. */}
        <dd className="pay-account">{d.accountNumber}</dd>
        <dt>{m.pay.accountName}</dt>
        <dd>{d.accountName}</dd>
        <dt>{m.pay.reference}</dt>
        <dd>{reference}</dd>
      </dl>

      <div className="row wrap" style={{ gap: 8 }}>
        <Button variant="outlined" onClick={() => copy(d.accountNumber, m.pay.copied)}>
          <Icon name="copy" size={16} slot="icon" />
          {m.pay.copyAccount}
        </Button>
        <Button variant="text" onClick={() => copy(String(amount), m.pay.copied)}>
          {m.pay.copyAmount}
        </Button>
      </div>

      {d.note ? (
        <p className="muted" style={{ margin: 0 }}>
          {d.note}
        </p>
      ) : null}
    </div>
  );
}
