import { type Registration } from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { markAttendance } from '../api/sessions.js';
import { queryKeys } from '../hooks/queries.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Button, Dialog, ErrorBanner } from './ui.js';

/**
 * The organizer's whole roster in one pass.
 *
 * The per-row control is safe now — pressing it only ever opens a question —
 * and that safety costs a modal per person. Standing on a pitch at the final
 * whistle that is the wrong trade, so the bulk path moved off the rows and up
 * here, where the card already says the sentence this control is: "Only mark
 * the people who did not turn up."
 *
 * Save writes only what actually moved. Deselecting somebody sends `null`, not
 * `true`: withdrawing a claim is not the same as making the opposite one, and a
 * sheet that stamped "played" across nine untouched rows would destroy the
 * presumption the nullable column exists to hold — and make `attendanceChecked`
 * assert a check nobody performed.
 */
export function NoShowSheet({
  sessionId,
  playing,
  onChanged,
}: {
  sessionId: string;
  /** The `status: 'in'` rows, in roster order. */
  playing: Registration[];
  onChanged(): void;
}) {
  const { m } = useLocale();
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const openSheet = () => {
    // Seeded from the record, so it opens showing what is already there and
    // Save has something honest to diff against.
    setPicked(new Set(playing.filter((r) => r.attended === false).map((r) => r.memberId)));
    setError(null);
    setOpen(true);
  };

  const toggle = (memberId: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(memberId)) next.add(memberId);
      return next;
    });

  const save = async () => {
    if (busy) return;
    // Annotated rather than inferred: the two branches produce different
    // literal types for `attended`, and the widening has to be to the
    // tri-state, not to `boolean`.
    const changes = playing.flatMap((r): { memberId: string; attended: boolean | null }[] => {
      const out = picked.has(r.memberId);
      if (out && r.attended !== false) return [{ memberId: r.memberId, attended: false }];
      if (!out && r.attended === false) return [{ memberId: r.memberId, attended: null }];
      return [];
    });
    if (changes.length === 0) {
      setOpen(false);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Sequential on purpose: each mark re-reads the roster server-side and
      // broadcasts, and three at once from a phone at the pitch is three
      // chances to interleave.
      for (const change of changes) await markAttendance(sessionId, change);
      setOpen(false);
      toast(m.toast.attendanceSheetSaved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.session.attendanceFailed);
    } finally {
      // Whatever landed before a failure is real, so the roster has to show it.
      // Pressing Save again then re-diffs against the new record and sends only
      // what is left — idempotent by construction.
      onChanged();
      void queryClient.invalidateQueries({ queryKey: queryKeys.form });
      for (const change of changes) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.profile(change.memberId) });
      }
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="text" onClick={openSheet}>
          {m.session.markNoShows}
        </Button>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        headline={m.session.noShowsTitle}
        actions={
          <>
            <Button variant="text" onClick={() => setOpen(false)}>
              {m.app.close}
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? m.app.saving : m.app.save}
            </Button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {m.session.noShowsBody}
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <ul className="mvp-list no-show-list">
          {playing.map((registration) => {
            const out = picked.has(registration.memberId);
            return (
              <li key={registration.memberId}>
                <button
                  type="button"
                  className={`mvp-choice${out ? ' is-out' : ''}`}
                  aria-pressed={out}
                  disabled={busy}
                  data-sound={out ? undefined : 'tap-out'}
                  onClick={() => toggle(registration.memberId)}
                >
                  <Avatar
                    memberId={registration.memberId}
                    name={registration.memberName}
                    avatarUpdatedAt={registration.memberAvatarUpdatedAt}
                    size={28}
                  />
                  <span className="mvp-name truncate">{registration.memberName}</span>
                  {out ? <Icon name="close" size={18} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted" style={{ margin: 0 }}>
          {picked.size === 0 ? m.session.noShowsNone : m.session.noShowsCount(picked.size)}
        </p>
      </Dialog>
    </>
  );
}
