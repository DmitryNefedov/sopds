import { createTheme } from '@mui/material/styles';

const NO_MOTION = {
  '*, *::before, *::after': {
    transitionDuration: '0.01ms !important',
    animationDuration: '0.01ms !important',
    animationIterationCount: '1 !important',
    scrollBehavior: 'auto !important',
  },
};

// Standard (LCD/OLED) theme.
function screenTheme(mode, { reducedMotion } = {}) {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#90caf9' : '#1565c0' },
      secondary: { main: '#8e24aa' },
      background:
        mode === 'dark'
          ? { default: '#0f1419', paper: '#161b22' }
          : { default: '#f5f6f8', paper: '#ffffff' },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: 'Roboto, system-ui, sans-serif',
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
    },
    components: {
      MuiCard: { defaultProps: { variant: 'outlined' } },
      MuiButton: { defaultProps: { disableElevation: true } },
      ...(reducedMotion
        ? {
            MuiCssBaseline: { styleOverrides: NO_MOTION },
            MuiButtonBase: { defaultProps: { disableRipple: true } },
          }
        : {}),
    },
  });
}

// E-ink theme: pure black on white, no colour coding, no shadows, no
// animation, sharp edges, larger hit targets. Tuned for slow grayscale
// displays such as the Lenovo Smart Paper / Onyx Boox.
function einkTheme() {
  const BLACK = '#000000';
  const NEAR = '#1a1a1a';
  const PAPER = '#ffffff';
  return createTheme({
    palette: {
      mode: 'light',
      contrastThreshold: 4.5,
      primary: { main: BLACK, contrastText: PAPER },
      secondary: { main: BLACK, contrastText: PAPER },
      text: { primary: BLACK, secondary: NEAR, disabled: '#5a5a5a' },
      background: { default: PAPER, paper: PAPER },
      divider: BLACK,
      action: {
        hover: 'transparent',
        hoverOpacity: 0,
        selected: '#e6e6e6',
        focus: '#d9d9d9',
        active: BLACK,
      },
      success: { main: BLACK },
      warning: { main: BLACK },
      error: { main: BLACK },
      info: { main: BLACK },
    },
    shape: { borderRadius: 0 },
    shadows: Array(25).fill('none'),
    typography: {
      fontFamily: 'Roboto, system-ui, sans-serif',
      fontSize: 15.5,
      h5: { fontWeight: 700 },
      h6: { fontWeight: 700 },
      subtitle2: { fontWeight: 700 },
      button: { fontWeight: 700, textTransform: 'none' },
      caption: { color: NEAR },
    },
    transitions: { create: () => 'none', duration: { shortest: 0, shorter: 0, short: 0, standard: 0, complex: 0, enteringScreen: 0, leavingScreen: 0 } },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '*, *::before, *::after': {
            transition: 'none !important',
            animation: 'none !important',
            scrollBehavior: 'auto !important',
          },
          body: { background: PAPER, color: BLACK, WebkitFontSmoothing: 'auto' },
          'a, a:visited': { color: BLACK },
          img: { imageRendering: 'auto' },
        },
      },
      MuiButtonBase: { defaultProps: { disableRipple: true, disableTouchRipple: true } },
      MuiButton: {
        defaultProps: { disableElevation: true, variant: 'outlined', color: 'primary' },
        styleOverrides: {
          root: { borderColor: BLACK, minHeight: 40, paddingInline: 14 },
          outlined: { borderWidth: 2, '&:hover': { borderWidth: 2, background: '#eaeaea' } },
          contained: { border: `2px solid ${BLACK}` },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { border: `1.5px solid ${BLACK}`, background: PAPER },
          filled: { background: BLACK, color: PAPER },
          outlined: { borderColor: BLACK },
        },
      },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: { root: { borderColor: BLACK, borderWidth: 1.5 } },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${BLACK}` }, outlined: { borderColor: BLACK } } },
      MuiAppBar: {
        styleOverrides: {
          root: { background: PAPER, color: BLACK, boxShadow: 'none', borderBottom: `2px solid ${BLACK}` },
        },
      },
      MuiDrawer: { styleOverrides: { paper: { borderRight: `2px solid ${BLACK}`, background: PAPER } } },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 48,
            '&.Mui-selected': { background: '#e0e0e0', outline: `2px solid ${BLACK}`, outlineOffset: -2 },
            '&:hover': { background: 'transparent' },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          notchedOutline: { borderColor: BLACK, borderWidth: 2 },
          root: { '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: BLACK }, background: PAPER },
        },
      },
      MuiTab: { styleOverrides: { root: { minHeight: 48, fontWeight: 700, '&.Mui-selected': { color: BLACK } } } },
      MuiTabs: { styleOverrides: { indicator: { height: 3, background: BLACK } } },
      MuiPagination: { defaultProps: { variant: 'outlined', shape: 'rounded' } },
      MuiPaginationItem: { styleOverrides: { root: { borderColor: BLACK, minWidth: 40, height: 40, '&.Mui-selected': { background: BLACK, color: PAPER } } } },
      MuiSwitch: {
        styleOverrides: {
          track: { border: `1px solid ${BLACK}`, backgroundColor: '#cfcfcf', opacity: 1 },
          thumb: { border: `1px solid ${BLACK}` },
          switchBase: { '&.Mui-checked + .MuiSwitch-track': { backgroundColor: BLACK, opacity: 1 } },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: BLACK } } },
      MuiTooltip: { styleOverrides: { tooltip: { background: BLACK, fontSize: 13 } } },
      MuiCircularProgress: { styleOverrides: { root: { color: BLACK } } },
      MuiAlert: {
        styleOverrides: {
          root: { border: `2px solid ${BLACK}`, background: PAPER, color: BLACK },
          icon: { color: BLACK },
          standardSuccess: { background: PAPER }, standardError: { background: PAPER },
          standardWarning: { background: PAPER }, standardInfo: { background: PAPER },
          outlined: { borderColor: BLACK },
        },
      },
    },
  });
}

export function buildTheme(mode, eink, opts = {}) {
  return eink ? einkTheme() : screenTheme(mode, opts);
}
