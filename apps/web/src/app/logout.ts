import { clearOffline } from '../store/offlineCache';

/**
 * Log out (D48): forget the offline copy of the data first (a shared device keeps no one's
 * house after they leave, D47), then go to the server's or the proxy's logout.
 */
export async function logOut(url: string, clear = clearOffline): Promise<void> {
  await clear();
  window.location.assign(url);
}
