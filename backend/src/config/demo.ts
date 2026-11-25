/**
 * The identity used by dev login and the sender-seed script.
 *
 * Defined once, here, on purpose. It used to be repeated in the login page, the
 * dev-login route and the seed script, so renaming it meant editing three places
 * -- and a browser still running the old login page posted the *old* email,
 * which no longer matched any account and silently created a new, empty one.
 * The login page now sends nothing when its email field is blank, and the
 * server applies this default.
 */
export const DEMO_IDENTITY = {
  email: 'akshat.sharma@outbox.local',
  name: 'Akshat Sharma',
} as const;
