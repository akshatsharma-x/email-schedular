'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Light / dark theme.
 *
 * Three rules worth stating, because each one is a bug if missed:
 *
 *  1. **No flash.** The stored preference is applied by a blocking inline script
 *     in the document head (see `themeScript`), before React hydrates. Setting
 *     it in an effect would paint light first and then snap to dark.
 *  2. **The OS is the default, not the decision.** With nothing stored we follow
 *     `prefers-color-scheme` and keep following it as it changes. Once the user
 *     picks a side explicitly, that wins and OS changes are ignored.
 *  3. **The class is on <html>**, so the background is right even outside body.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'outbox-theme';

interface ThemeContextValue {
  theme: Theme;
  /** True while the preference comes from the OS rather than an explicit pick. */
  isSystem: boolean;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Inlined into <head> via dangerouslySetInnerHTML. Kept tiny and dependency
 * free because it runs before anything else on the page.
 */
export const themeScript = `(function(){try{
var s=localStorage.getItem('${STORAGE_KEY}');
var d=s==='dark'||(!s&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.setAttribute('data-theme', d?'dark':'light');
}catch(e){}})();`;

function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  // Initialised from the attribute the inline script already set, so the first
  // render agrees with what is on screen.
  const [theme, setThemeState] = useState<Theme>('light');
  const [isSystem, setIsSystem] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    const current =
      (document.documentElement.getAttribute('data-theme') as Theme | null) ?? 'light';
    setThemeState(current);
    setIsSystem(!stored);
  }, []);

  // Keep following the OS until the user makes an explicit choice.
  useEffect(() => {
    if (!isSystem) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      const next: Theme = e.matches ? 'dark' : 'light';
      apply(next);
      setThemeState(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [isSystem]);

  const setTheme = useCallback((next: Theme) => {
    apply(next);
    setThemeState(next);
    setIsSystem(false);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse storage; the theme still applies for the
      // session, it just will not persist.
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    [theme, setTheme],
  );

  const value = useMemo(
    () => ({ theme, isSystem, toggle, setTheme }),
    [theme, isSystem, toggle, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx;
}
