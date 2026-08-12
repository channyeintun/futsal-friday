import { buildVietQrPayload } from '@futsal/shared';
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A VietQR the payer's banking app can read.
 *
 * Drawn as inline SVG rather than a canvas or an `<img>`: it stays crisp at
 * any size, needs no object URL to clean up, and — the part that matters on a
 * phone — survives being screenshotted and re-scanned from the photo library,
 * which is how somebody pays from the same device the QR is displayed on.
 *
 * The encoder is a dependency on purpose. A QR is Reed-Solomon over GF(256)
 * plus mask selection, and this payload is somebody's bank account: a subtly
 * wrong hand-rolled encoder produces a code that scans to the wrong digits
 * rather than one that visibly fails.
 */
export function PaymentQr({
  bankBin,
  accountNumber,
  amount,
  reference,
  size = 220,
}: {
  bankBin: string;
  accountNumber: string;
  /** Integer dong. Zero or undefined makes a static code with no amount. */
  amount?: number;
  reference?: string;
  size?: number;
}) {
  const modules = useMemo(() => {
    let payload: string;
    try {
      payload = buildVietQrPayload({ bankBin, accountNumber, amount, reference });
    } catch {
      // Bad details are the organizer's to fix in Setup; the card above this
      // still shows them in text, so the screen is not left useless.
      return null;
    }

    // Type 0 lets the library pick the smallest version that fits. 'M' is the
    // error correction VietQR codes are normally printed at.
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();

    const count = qr.getModuleCount();
    const dark: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) dark.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { count, path: dark.join('') };
  }, [bankBin, accountNumber, amount, reference]);

  if (!modules) return null;

  // A quiet zone of four modules is required by the spec; scanners rely on it.
  const quiet = 4;
  const extent = modules.count + quiet * 2;

  return (
    <div className="payment-qr">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${extent} ${extent}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="VietQR"
      >
        {/* Always white behind the code, in both themes: scanners expect dark
            modules on a light field, and inverting one is a coin flip. */}
        <rect width={extent} height={extent} fill="#ffffff" />
        <g transform={`translate(${quiet} ${quiet})`} fill="#000000">
          <path d={modules.path} />
        </g>
      </svg>
    </div>
  );
}
