import {
  type SessionMessage,
  MAX_MESSAGE_LENGTH,
  canDeleteMessage,
  relativeToNow,
} from '@futsal/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteSessionMessage, postSessionMessage } from '../api/sessions.js';
import { queryKeys, useSessionMessages } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';
import { Avatar } from './Avatar.js';
import { Button, ErrorBanner, TextField } from './ui.js';

/**
 * The thread.
 *
 * The group already does this in the chat all week; the app was the one place
 * that knew who was playing and had nothing to say about it. Putting it against
 * the session means the winding-up sits with the game it is about, instead of
 * scrolling away above three hundred messages about lunch.
 *
 * Open to anybody on any session that has not been cancelled — not gated on
 * kickoff, on having signed up, or on being the organizer. The person with the
 * most to say about a game is often the one who is not playing it, and a thread
 * that only opens for two hours on a Friday is a thread nobody uses.
 *
 * Deliberately not a notification. A jab is worth reading when you next open
 * the app; it is not worth a buzz in somebody's pocket.
 */
export function TrashTalk({ sessionId, canPost }: { sessionId: string; canPost: boolean }) {
  const { identity } = useApp();
  const { m, locale } = useLocale();
  const queryClient = useQueryClient();
  const messages = useSessionMessages(sessionId);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = draft.trim();
  const tooLong = body.length > MAX_MESSAGE_LENGTH;

  /*
   * The response goes into the cache, rather than waiting for the echo.
   *
   * The realtime event carries every message to every phone including the
   * writer's, so it is tempting to let that be the only path — but it makes
   * your own message wait on a round trip through Redis, and where realtime is
   * unavailable and the client has fallen back to polling it would not appear
   * for thirty seconds. Posting something and watching nothing happen is how
   * you get the same joke three times.
   *
   * The echo is deduplicated by id in `useLiveSession`, so whichever lands
   * second is a no-op.
   */
  const applyLocally = (update: (thread: SessionMessage[]) => SessionMessage[]) => {
    queryClient.setQueryData<SessionMessage[]>(
      queryKeys.sessionMessages(sessionId),
      (current) => (current ? update(current) : current),
    );
  };

  const send = async () => {
    if (busy || !body || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const { message } = await postSessionMessage(sessionId, body);
      applyLocally((thread) =>
        thread.some((existing) => existing.id === message.id) ? thread : [...thread, message],
      );
      // Cleared on success only: a failed send that also ate what you typed is
      // the worst possible outcome for a one-line joke.
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.talk.failed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (message: SessionMessage) => {
    setError(null);
    try {
      await deleteSessionMessage(sessionId, message.id);
      applyLocally((thread) => thread.filter((existing) => existing.id !== message.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.talk.failed);
    }
  };

  const thread = messages.data ?? [];

  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">{m.talk.title}</h2>
        {thread.length > 0 ? <span className="muted">{m.talk.count(thread.length)}</span> : null}
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {messages.isPending ? null : thread.length === 0 ? (
        <p className="empty">{canPost ? m.talk.empty : m.talk.emptyClosed}</p>
      ) : (
        <ul className="talk-list">
          {thread.map((message) => {
            const mine = message.memberId === identity.memberId;
            return (
              <li key={message.id} className={`talk-row${mine ? ' is-me' : ''}`}>
                <Avatar
                  memberId={message.memberId}
                  name={message.memberName}
                  avatarUpdatedAt={message.memberAvatarUpdatedAt}
                  size={28}
                />
                <div className="talk-bubble">
                  <div className="row between" style={{ gap: 8 }}>
                    <span className="talk-who truncate">{message.memberName}</span>
                    <span className="talk-when">
                      {relativeToNow(message.createdAt, new Date(), locale)}
                    </span>
                  </div>
                  {/* Whatever they typed, as they typed it — newlines and all.
                      `white-space: pre-wrap` in the stylesheet, not a parser:
                      nothing here is markup and pretending otherwise would be
                      the one way a joke could become an injection. */}
                  <p className="talk-body">{message.body}</p>
                </div>

                {canDeleteMessage(message, identity) ? (
                  <button
                    type="button"
                    className="talk-remove"
                    onClick={() => void remove(message)}
                    aria-label={m.talk.remove}
                    title={m.talk.remove}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canPost ? (
        <>
          <TextField
            label={m.talk.placeholder}
            value={draft}
            onChange={setDraft}
            type="textarea"
            errorText={tooLong ? m.talk.tooLong(MAX_MESSAGE_LENGTH) : undefined}
          />
          <Button onClick={() => void send()} disabled={busy || !body || tooLong}>
            {busy ? m.app.working : m.talk.send}
          </Button>
        </>
      ) : null}
    </div>
  );
}
