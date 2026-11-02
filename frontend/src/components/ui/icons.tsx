import type { ReactNode, SVGProps } from 'react';

/**
 * Inline icon set.
 *
 * Hand-rolled rather than pulled from an icon package: the app needs ~20 glyphs
 * and they all share one 24-grid, 1.75 stroke and `currentColor`, so they
 * inherit text colour and theme automatically. No runtime, no tree-shaking
 * questions, no second visual language.
 *
 * Every icon is `aria-hidden` by default — these sit beside text labels, so
 * announcing them would just duplicate the label.
 */

type Props = SVGProps<SVGSVGElement>;

const Base = ({ children, ...rest }: Props & { children: ReactNode }): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

export const IconSearch = (p: Props): ReactNode => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Base>
);

export const IconFilter = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Base>
);

export const IconRefresh = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M20 11a8 8 0 10-2.3 5.7" />
    <path d="M20 5v6h-6" />
  </Base>
);

export const IconClock = (p: Props): ReactNode => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Base>
);

export const IconSend = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M4.5 11.5L20 4l-7.5 15.5-2-6-6-2z" />
  </Base>
);

export const IconStar = ({ filled = false, ...p }: Props & { filled?: boolean }): ReactNode => (
  <Base {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8L12 4z" />
  </Base>
);

export const IconArrowLeft = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Base>
);

export const IconChevronDown = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Base>
);

export const IconPaperclip = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" />
  </Base>
);

export const IconUpload = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
  </Base>
);

export const IconCalendar = (p: Props): ReactNode => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8.5 3.5v3M15.5 3.5v3" />
  </Base>
);

export const IconX = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Base>
);

export const IconCheck = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Base>
);

export const IconAlert = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M12 4.5l8.5 15H3.5L12 4.5z" />
    <path d="M12 10v4M12 17.2v.2" />
  </Base>
);

export const IconInfo = (p: Props): ReactNode => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </Base>
);

export const IconSun = (p: Props): ReactNode => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
  </Base>
);

export const IconMoon = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </Base>
);

export const IconInbox = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M3.5 12.5L6 5.5h12l2.5 7" />
    <path d="M3.5 12.5h5l1 2.5h5l1-2.5h5v4a2 2 0 01-2 2H5.5a2 2 0 01-2-2v-4z" />
  </Base>
);

export const IconUsers = (p: Props): ReactNode => (
  <Base {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M3 19.5a6 6 0 0112 0" />
    <path d="M16 5.6a3.5 3.5 0 010 5.8M17.5 19.5a6 6 0 00-1.6-4.1" />
  </Base>
);

export const IconSlack = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M9 3.5v8M15 12.5v8M3.5 15h8M12.5 9h8" />
  </Base>
);

export const IconLogout = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M15 4.5h3a2 2 0 012 2v11a2 2 0 01-2 2h-3" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </Base>
);

export const IconFile = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M13.5 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V9l-5.5-5.5z" />
    <path d="M13.5 3.5V9H19" />
  </Base>
);

export const IconTrash = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M4.5 7h15M9.5 7V5a1 1 0 011-1h3a1 1 0 011 1v2" />
    <path d="M6.5 7l.8 12a2 2 0 002 1.9h5.4a2 2 0 002-1.9l.8-12" />
  </Base>
);

export const IconExternal = (p: Props): ReactNode => (
  <Base {...p}>
    <path d="M14 4.5h5.5V10" />
    <path d="M19.5 4.5L11 13" />
    <path d="M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" />
  </Base>
);

export const IconGoogle = (p: Props): ReactNode => (
  <svg viewBox="0 0 18 18" aria-hidden="true" {...p}>
    <path
      fill="#4285F4"
      d="M17.6 9.2c0-.6-.1-1.2-.2-1.7H9v3.3h4.8a4.1 4.1 0 01-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9a5.4 5.4 0 01-5.1-3.7H.9v2.3A9 9 0 009 18z"
    />
    <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 010-3.4V5H.9a9 9 0 000 8l3-2.3z" />
    <path
      fill="#EA4335"
      d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 00.9 5l3 2.3A5.4 5.4 0 019 3.6z"
    />
  </svg>
);
