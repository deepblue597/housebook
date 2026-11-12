/** "Home look" on or off (D41): the same plan with floor and wall finishes. Per browser. */
import { useUi } from '../store/ui';

export function LookToggle() {
  const look = useUi((s) => s.look);
  const setLook = useUi((s) => s.setLook);
  return (
    <button
      type="button"
      className="fit"
      aria-pressed={look === 'home'}
      title="Show floor and wall finishes instead of the plan colours"
      onClick={() => setLook(look === 'home' ? 'plan' : 'home')}
    >
      Home look
    </button>
  );
}
