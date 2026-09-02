import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Pagination,
  Stack,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { bookCoverUrl, bookDownloadUrl } from '../api.js';

export function Loading() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress />
    </Box>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <Alert
      severity="error"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    >
      {String(error?.message || error || 'Something went wrong')}
    </Alert>
  );
}

export function Empty({ children = 'Nothing found.' }) {
  return (
    <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
      {children}
    </Typography>
  );
}

// Renders {loading,error,data} from useApi with a consistent look.
export function Async({ query, children }) {
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.reload} />;
  return children(query.data);
}

export function Pager({ meta, page, onChange }) {
  if (!meta || meta.pages <= 1) return null;
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
      <Pagination
        count={meta.pages}
        page={page}
        onChange={(_, p) => onChange(p)}
        color="primary"
      />
    </Box>
  );
}

export function BookCard({ book }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardActionArea
        component={RouterLink}
        to={`/books/${book.id}`}
        sx={{ flexGrow: 1 }}
      >
        <Box
          sx={{
            aspectRatio: '2 / 3',
            bgcolor: 'action.hover',
            backgroundImage: `url(${bookCoverUrl(book.id)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
        <CardContent sx={{ pb: 1 }}>
          <Typography variant="subtitle2" noWrap title={book.title}>
            {book.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {book.authors?.map((a) => a.full_name).join(', ') || '—'}
          </Typography>
          {book.doubles > 0 && (
            <Chip size="small" label={`+${book.doubles} dup`} sx={{ ml: 0.5 }} />
          )}
        </CardContent>
      </CardActionArea>
      <Box sx={{ px: 2, pb: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" label={book.format?.toUpperCase()} />
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          href={bookDownloadUrl(book.id)}
        >
          Download
        </Button>
      </Box>
    </Card>
  );
}

export function BookGrid({ books }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: {
          xs: 'repeat(2, 1fr)',
          sm: 'repeat(3, 1fr)',
          md: 'repeat(4, 1fr)',
          lg: 'repeat(5, 1fr)',
        },
      }}
    >
      {books.map((b) => (
        <BookCard key={`${b.id}-${b.filename}`} book={b} />
      ))}
    </Box>
  );
}

export function Crumbs({ items }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ mb: 2, flexWrap: 'wrap', alignItems: 'center' }}
    >
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Typography color="text.secondary">/</Typography>}
          {it.to ? (
            <Button size="small" component={RouterLink} to={it.to}>
              {it.label}
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {it.label}
            </Typography>
          )}
        </React.Fragment>
      ))}
    </Stack>
  );
}
