import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUi } from './ui';

describe('plan style (2D/3D)', () => {
  afterEach(() => {
    localStorage.clear();
    useUi.setState({ planStyle: '2d', view: 'plan', scene3dIssue: null });
  });

  it('defaults to 2D and remembers the choice per browser', () => {
    expect(useUi.getState().planStyle).toBe('2d');
    useUi.setState({ view: 'list' });
    useUi.getState().setPlanStyle('3d');
    expect(useUi.getState()).toMatchObject({ planStyle: '3d', view: 'plan' });
    expect(localStorage.getItem('housebook.planStyle')).toBe('3d');
    expect(localStorage.getItem('housebook.view')).toBe('plan');
  });

  it('choosing 3D again clears a context loss (the "reload 3D" button)', () => {
    useUi.getState().setScene3dIssue('context_lost');
    useUi.getState().setPlanStyle('3d');
    expect(useUi.getState().scene3dIssue).toBeNull();
  });

  it('works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => useUi.getState().setPlanStyle('3d')).not.toThrow();
    expect(useUi.getState().planStyle).toBe('3d');
  });
});
