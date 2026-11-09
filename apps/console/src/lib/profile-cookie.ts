/** Persist the viewed profile so later reads and writes stay on it. */
export function setActiveProfileCookie(profileId: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `rz_profile_id=${encodeURIComponent(profileId)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}
