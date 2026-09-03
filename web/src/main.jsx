import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { buildTheme } from './theme.js';
import { resolveEink, setEinkPref, mediaSaysEink } from './eink.js';
import { setCoverEink } from './api.js';
import App from './App.jsx';

export const ColorModeContext = React.createContext({ toggle: () => {} });
export const EinkContext = React.createContext({
  eink: false,
  detected: false,
  toggle: () => {},
});

const initial = resolveEink();
setCoverEink(initial.eink);

function Root() {
  const [mode, setMode] = useState(
    () => localStorage.getItem('sopds-mode') || 'light',
  );
  const [eink, setEink] = useState(initial.eink);

  // React to a device that starts reporting (update: slow) after load.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mqls = ['(update: slow)', '(monochrome)'].map((q) =>
      window.matchMedia(q),
    );
    const onChange = () => {
      if (localStorage.getItem('sopds-eink') === null && mediaSaysEink())
        setEink(true);
    };
    mqls.forEach((m) => m.addEventListener?.('change', onChange));
    return () =>
      mqls.forEach((m) => m.removeEventListener?.('change', onChange));
  }, []);

  const theme = useMemo(() => buildTheme(mode, eink), [mode, eink]);

  useEffect(() => {
    document.documentElement.setAttribute('data-eink', eink ? 'true' : 'false');
    setCoverEink(eink);
  }, [eink]);

  const colorCtx = useMemo(
    () => ({
      mode,
      toggle: () =>
        setMode((m) => {
          const next = m === 'light' ? 'dark' : 'light';
          localStorage.setItem('sopds-mode', next);
          return next;
        }),
    }),
    [mode],
  );

  const einkCtx = useMemo(
    () => ({
      eink,
      detected: initial.detected,
      toggle: () =>
        setEink((v) => {
          setEinkPref(!v);
          return !v;
        }),
    }),
    [eink],
  );

  return (
    <ColorModeContext.Provider value={colorCtx}>
      <EinkContext.Provider value={einkCtx}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </EinkContext.Provider>
    </ColorModeContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
