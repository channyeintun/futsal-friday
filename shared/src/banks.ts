/**
 * The banks a VietQR can be addressed to.
 *
 * A trimmed NAPAS list — the ones a Ho Chi Minh City friend group plausibly
 * banks with, plus the wallets, rather than all sixty-odd including foreign
 * branch offices. `bin` is the acquirer id VietQR identifies a bank by and is
 * the only field that must be exact; the names are for the picker.
 *
 * Shipped as data rather than fetched, deliberately. A remote list would put
 * a third party between the organizer and their own account number, and add a
 * network dependency to a screen that has to work when somebody is standing
 * at a pitch with one bar of signal.
 */
export interface Bank {
  /** NAPAS acquirer id, six digits. */
  bin: string;
  name: string;
}

export const BANKS: readonly Bank[] = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970422', name: 'MB Bank' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970416', name: 'ACB' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' },
  { bin: '970437', name: 'HDBank' },
  { bin: '970448', name: 'OCB' },
  { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' },
  { bin: '970431', name: 'Eximbank' },
  { bin: '970426', name: 'MSB' },
  { bin: '970440', name: 'SeABank' },
  { bin: '970449', name: 'LPBank' },
  { bin: '970429', name: 'SCB' },
  { bin: '970425', name: 'ABBANK' },
  { bin: '970428', name: 'Nam A Bank' },
  { bin: '970412', name: 'PVcomBank' },
  { bin: '970454', name: 'BVBank' },
  { bin: '963388', name: 'Timo' },
  { bin: '546034', name: 'Cake by VPBank' },
  { bin: '971025', name: 'MoMo' },
  { bin: '971005', name: 'Viettel Money' },
  { bin: '971011', name: 'VNPT Money' },
];

export function bankByBin(bin: string): Bank | undefined {
  return BANKS.find((b) => b.bin === bin);
}
