import React, { useContext, useState } from 'react';
import {
  Routes,
  Route,
  Link as RouterLink,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import {
  AppBar,
  Box,
  Container,
  Drawer,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  alpha,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';
import HomeIcon from '@mui/icons-material/Home';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import PersonIcon from '@mui/icons-material/Person';
import CollectionsBookmarkIcon from '@mui/icons-material/CollectionsBookmark';
import CategoryIcon from '@mui/icons-material/Category';
import FolderIcon from '@mui/icons-material/Folder';
import SettingsIcon from '@mui/icons-material/Settings';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { ColorModeContext } from './main.jsx';

import Home from './pages/Home.jsx';
import SearchResults from './pages/SearchResults.jsx';
import BookDetail from './pages/BookDetail.jsx';
import Authors from './pages/Authors.jsx';
import Series from './pages/Series.jsx';
import Genres from './pages/Genres.jsx';
import BookList from './pages/BookList.jsx';
import Catalogs from './pages/Catalogs.jsx';
import Admin from './pages/Admin.jsx';

const NAV = [
  { to: '/', label: 'Home', icon: <HomeIcon /> },
  { to: '/books', label: 'Books', icon: <MenuBookIcon /> },
  { to: '/authors', label: 'Authors', icon: <PersonIcon /> },
  { to: '/series', label: 'Series', icon: <CollectionsBookmarkIcon /> },
  { to: '/genres', label: 'Genres', icon: <CategoryIcon /> },
  { to: '/catalogs', label: 'Catalogs', icon: <FolderIcon /> },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

function SearchField() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`);
      }}
      sx={{
        position: 'relative',
        borderRadius: 2,
        bgcolor: alpha(theme.palette.common.white, 0.15),
        '&:hover': { bgcolor: alpha(theme.palette.common.white, 0.25) },
        ml: { xs: 1, sm: 3 },
        flexGrow: 1,
        maxWidth: 560,
      }}
    >
      <Box sx={{ position: 'absolute', pl: 1.5, height: '100%', display: 'flex', alignItems: 'center' }}>
        <SearchIcon />
      </Box>
      <InputBase
        placeholder="Search authors, books, series…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        sx={{ color: 'inherit', pl: 5, pr: 1, py: 1, width: '100%' }}
      />
    </Box>
  );
}

export default function App() {
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const colorMode = useContext(ColorModeContext);
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const location = useLocation();

  const drawer = (
    <List sx={{ width: 240 }}>
      {NAV.map((n) => (
        <ListItemButton
          key={n.to}
          component={RouterLink}
          to={n.to}
          selected={
            n.to === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(n.to)
          }
          onClick={() => setOpen(false)}
        >
          <ListItemIcon>{n.icon}</ListItemIcon>
          <ListItemText primary={n.label} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          {!isDesktop && (
            <IconButton color="inherit" edge="start" onClick={() => setOpen(true)} sx={{ mr: 1 }}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ color: 'inherit', textDecoration: 'none', whiteSpace: 'nowrap', display: { xs: 'none', sm: 'block' } }}
          >
            SimpleOPDS
          </Typography>
          <SearchField />
          <Box sx={{ flexGrow: 1 }} />
          <IconButton color="inherit" onClick={colorMode.toggle}>
            {theme.palette.mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Toolbar>
      </AppBar>

      {isDesktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: 240,
            flexShrink: 0,
            [`& .MuiDrawer-paper`]: { width: 240, boxSizing: 'border-box' },
          }}
        >
          <Toolbar />
          {drawer}
        </Drawer>
      ) : (
        <Drawer open={open} onClose={() => setOpen(false)}>
          <Toolbar />
          {drawer}
        </Drawer>
      )}

      <Box component="main" sx={{ flexGrow: 1, width: 0 }}>
        <Toolbar />
        <Container maxWidth="lg" sx={{ py: 3 }}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/books" element={<BookList />} />
            <Route path="/books/:id" element={<BookDetail />} />
            <Route path="/authors" element={<Authors />} />
            <Route path="/authors/:id" element={<Authors />} />
            <Route path="/series" element={<Series />} />
            <Route path="/series/:id" element={<Series />} />
            <Route path="/genres" element={<Genres />} />
            <Route path="/genres/:id" element={<Genres />} />
            <Route path="/catalogs" element={<Catalogs />} />
            <Route path="/settings" element={<Admin />} />
          </Routes>
        </Container>
      </Box>
    </Box>
  );
}
