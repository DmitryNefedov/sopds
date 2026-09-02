import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { buildTheme } from './theme.js';
import App from './App.jsx';

export const ColorModeContext = React.createContext({ toggle: () => {} });

function Root() {
  const [mode, setMode] = useState(
    () => localStorage.getItem('sopds-mode') || 'light',
  );
  const theme = useMemo(() => buildTheme(mode), [mode]);
  const ctx = useMemo(
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

  return (
    <ColorModeContext.Provider value={ctx}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
