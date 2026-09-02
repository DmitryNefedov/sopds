import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Grid,
  Typography,
} from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookCard } from '../components/common.jsx';

function StatCard({ label, value, to }) {
  return (
    <Card
      component={to ? RouterLink : 'div'}
      to={to}
      sx={{ textDecoration: 'none', display: 'block' }}
    >
      <CardContent>
        <Typography variant="h4">{value ?? '—'}</Typography>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const stats = useApi('/stats', []);
  const random = useApi('/random', []);

  return (
    <Box>
      <Async query={stats}>
        {(s) => (
          <>
            <Typography variant="h5" gutterBottom>
              {s.title}
            </Typography>
            <Typography color="text.secondary" gutterBottom>
              {s.subtitle}
            </Typography>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={6} sm={3}>
                <StatCard label="Books" value={s.allbooks} to="/books" />
              </Grid>
              <Grid item xs={6} sm={3}>
                <StatCard label="Authors" value={s.allauthors} to="/authors" />
              </Grid>
              <Grid item xs={6} sm={3}>
                <StatCard label="Series" value={s.allseries} to="/series" />
              </Grid>
              <Grid item xs={6} sm={3}>
                <StatCard label="Genres" value={s.allgenres} to="/genres" />
              </Grid>
            </Grid>
            {s.lastscan && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                Last scan: {new Date(s.lastscan.replace(' ', 'T') + 'Z').toLocaleString()}
              </Typography>
            )}
          </>
        )}
      </Async>

      <Typography variant="h6" sx={{ mt: 4, mb: 1 }}>
        Random pick
      </Typography>
      <Async query={random}>
        {(book) =>
          book ? (
            <Box sx={{ maxWidth: 240 }}>
              <BookCard book={book} />
            </Box>
          ) : (
            <Typography color="text.secondary">
              No books yet. Run the scanner to import your collection.
            </Typography>
          )
        }
      </Async>
    </Box>
  );
}
