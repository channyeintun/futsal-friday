import { formatKickoff } from '@futsal/shared';
import { Icon } from '../components/Icon.js';
import { ProfileCard } from '../components/ProfileCard.js';
import { ErrorBanner, Spinner } from '../components/ui.js';
import { useHistory, useProfile } from '../hooks/queries.js';
import { useApp } from '../state/app.js';
import { useLocale } from '../state/locale.js';

/**
 * Somebody else's profile, reached by tapping their name on a session.
 *
 * Deliberately thinner than your own History screen: their run and their
 * recent matches, but none of their money. Who owes what is between them and
 * the organizer.
 */
export function ProfilePage({ memberId }: { memberId: string }) {
  const { identity } = useApp();
  const { m, locale } = useLocale();
  const profile = useProfile(memberId);

  // Somebody else's match list is the organizer's business, or your own.
  const history = useHistory(memberId, identity.isOrganizer || memberId === identity.memberId);

  if (profile.isPending) return <Spinner label={m.app.loading} />;
  if (profile.error || !profile.data) {
    return <ErrorBanner>{m.profile.couldNotLoad}</ErrorBanner>;
  }

  const played = (history.data ?? []).filter((entry) => entry.registrationStatus === 'in');

  return (
    <>
      <ProfileCard profile={profile.data} />

      {played.length > 0 ? (
        <div className="card">
          <h2 className="card-title">{m.history.recent}</h2>
          {played.slice(0, 10).map((entry) => (
            <div key={entry.session.id} className="player-row">
              <Icon name="ball" size={18} />
              <span className="grow truncate">
                {formatKickoff(entry.session.startsAt, locale)}
              </span>
              {entry.session.venue ? (
                <span className="muted truncate">{entry.session.venue.name}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
