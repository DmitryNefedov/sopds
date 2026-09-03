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

// E-ink theme: a refined grayscale design (no colour), tuned for the 16-level
// grayscale panels on the Lenovo Smart Paper / Onyx Boox. No animation and no
// soft shadows (they ghost), but rounded corners, layered gray tones and light
// borders instead of everything being a hard 2px black rule.
function einkTheme() {
  // grayscale ramp
  const INK = '#1c1c1c'; // primary text, filled surfaces
  const INK2 = '#4d4d4d'; // secondary text, strong icons
  const INK3 = '#7a7a7a'; // tertiary / disabled
  const LINE = '#c9c9c9'; // default borders & dividers
  const LINE2 = '#9a9a9a'; // stronger borders (inputs, selected)
  const FILL = '#ededed'; // selected rows, quiet surfaces
  const FILL2 = '#f5f5f5'; // hover-less "raised" cue on plain areas
  const CARD = '#ffffff';
  const BG = '#f4f4f4'; // app background so white cards read as raised
  const ACCENT = '#242424'; // buttons, tab indicator, filled chips
  const R = 8;

  return createTheme({
    palette: {
      mode: 'light',
      contrastThreshold: 4.5,
      primary: { main: ACCENT, contrastText: CARD },
      secondary: { main: INK2, contrastText: CARD },
      text: { primary: INK, secondary: INK2, disabled: INK3 },
      background: { default: BG, paper: CARD },
      divider: LINE,
      action: {
        hover: FILL2,
        hoverOpacity: 0.04,
        selected: FILL,
        focus: FILL,
        active: INK2,
        disabled: INK3,
        disabledBackground: FILL,
      },
      success: { main: INK },
      warning: { main: INK },
      error: { main: INK },
      info: { main: INK2 },
      grey: { 300: LINE, 500: LINE2, 700: INK2, 900: INK },
    },
    shape: { borderRadius: R },
    shadows: Array(25).fill('none'),
    typography: {
      fontFamily: 'Roboto, system-ui, sans-serif',
      fontSize: 15.5,
      h4: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 600, textTransform: 'none' },
      overline: { color: INK2, letterSpacing: 0.6 },
      caption: { color: INK2 },
    },
    transitions: {
      create: () => 'none',
      duration: {
        shortest: 0, shorter: 0, short: 0, standard: 0,
        complex: 0, enteringScreen: 0, leavingScreen: 0,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '*, *::before, *::after': {
            transition: 'none !important',
            animation: 'none !important',
            scrollBehavior: 'auto !important',
          },
          body: { background: BG, color: INK, WebkitFontSmoothing: 'auto' },
          'a, a:visited': { color: INK, textUnderlineOffset: 2 },
        },
      },
      MuiButtonBase: {
        defaultProps: { disableRipple: true, disableTouchRipple: true },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, color: 'primary' },
        styleOverrides: {
          root: { minHeight: 40, paddingInline: 16, borderRadius: R },
          outlined: {
            borderColor: LINE2,
            borderWidth: 1.5,
            color: INK,
            '&:hover': { borderWidth: 1.5, borderColor: INK2, background: FILL },
          },
          contained: {
            background: ACCENT,
            color: CARD,
            '&:hover': { background: INK },
          },
          text: { color: INK, '&:hover': { background: FILL } },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { border: `1px solid ${LINE2}`, background: CARD, borderRadius: 7 },
          label: { fontWeight: 500 },
          filled: { background: ACCENT, color: CARD, border: `1px solid ${ACCENT}` },
          outlined: { borderColor: LINE2 },
          clickable: { '&:hover': { background: FILL } },
        },
      },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: {
          root: { borderColor: LINE, borderRadius: 12, background: CARD },
        },
      },
      MuiCardActionArea: {
        styleOverrides: { focusHighlight: { display: 'none' } },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          outlined: { borderColor: LINE },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            background: CARD,
            color: INK,
            boxShadow: 'none',
            borderBottom: `1px solid ${LINE2}`,
          },
        },
      },
      MuiToolbar: { styleOverrides: { root: { minHeight: 60 } } },
      MuiDrawer: {
        styleOverrides: {
          paper: { borderRight: `1px solid ${LINE}`, background: CARD },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 46,
            borderRadius: R,
            marginInline: 6,
            '&.Mui-selected': {
              background: FILL,
              fontWeight: 600,
              '&:hover': { background: FILL },
            },
            '&:hover': { background: FILL2 },
          },
        },
      },
      MuiListItemIcon: { styleOverrides: { root: { color: INK2, minWidth: 40 } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: R,
            background: CARD,
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: INK2 },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderColor: INK,
              borderWidth: 1.5,
            },
          },
          notchedOutline: { borderColor: LINE2, borderWidth: 1.5 },
        },
      },
      MuiInputBase: { styleOverrides: { input: { '&::placeholder': { color: INK3, opacity: 1 } } } },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 46,
            fontWeight: 600,
            color: INK2,
            '&.Mui-selected': { color: INK },
          },
        },
      },
      MuiTabs: {
        styleOverrides: { indicator: { height: 3, borderRadius: 2, background: ACCENT } },
      },
      MuiPagination: { defaultProps: { variant: 'outlined', shape: 'rounded' } },
      MuiPaginationItem: {
        styleOverrides: {
          root: {
            borderColor: LINE2,
            minWidth: 40,
            height: 40,
            borderRadius: R,
            '&.Mui-selected': {
              background: ACCENT,
              color: CARD,
              borderColor: ACCENT,
              '&:hover': { background: INK },
            },
          },
        },
      },
      MuiSwitch: {
        styleOverrides: {
          root: { padding: 8 },
          track: {
            border: `1px solid ${LINE2}`,
            backgroundColor: '#dcdcdc',
            opacity: 1,
            borderRadius: 12,
          },
          thumb: { boxShadow: 'none', border: `1px solid ${INK3}`, backgroundColor: CARD },
          switchBase: {
            '&.Mui-checked': { color: CARD },
            '&.Mui-checked .MuiSwitch-thumb': { backgroundColor: CARD, borderColor: INK },
            '&.Mui-checked + .MuiSwitch-track': {
              backgroundColor: ACCENT,
              opacity: 1,
              borderColor: ACCENT,
            },
          },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: LINE } } },
      MuiTooltip: {
        styleOverrides: { tooltip: { background: ACCENT, color: CARD, fontSize: 13, borderRadius: 6 } },
      },
      MuiCircularProgress: { styleOverrides: { root: { color: INK2 } } },
      MuiSnackbarContent: {
        styleOverrides: { root: { background: ACCENT, color: CARD, borderRadius: R } },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            border: `1px solid ${LINE2}`,
            background: CARD,
            color: INK,
            borderRadius: R,
          },
          icon: { color: INK2 },
          filled: { background: ACCENT, color: CARD, border: `1px solid ${ACCENT}` },
          filledInfo: { background: ACCENT, color: CARD },
          standardSuccess: { background: FILL2 },
          standardError: { background: FILL2 },
          standardWarning: { background: FILL2 },
          standardInfo: { background: FILL2 },
          outlined: { borderColor: LINE2 },
        },
      },
    },
  });
}

export function buildTheme(mode, eink, opts = {}) {
  return eink ? einkTheme() : screenTheme(mode, opts);
}
