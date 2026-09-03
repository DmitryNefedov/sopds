import React, { useContext } from 'react';
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
import { bookCoverUrl, bookDownloadUrl } from '../api.js';
import { EinkContext } from '../main.jsx';

const ALL_FORMATS = ['fb2', 'epub', 'mobi'];

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
  const { eink } = useContext(EinkContext);
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardActionArea
        component={RouterLink}
        to={`/books/${book.id}`}
        sx={{ flexGrow: 1 }}
      >
        <Box sx={eink ? { p: 1, pb: 0 } : undefined}>
          <Box
            component="img"
            src={bookCoverUrl(book.id)}
            alt=""
            loading="lazy"
            sx={{
              display: 'block',
              width: '100%',
              aspectRatio: '2 / 3',
              objectFit: 'cover',
              bgcolor: eink ? 'grey.300' : 'action.hover',
              border: eink ? '1px solid' : 'none',
              borderColor: 'divider',
              borderRadius: eink ? 1.5 : 0,
              filter: eink ? 'grayscale(1) contrast(1.06)' : 'none',
            }}
          />
        </Box>
        <CardContent sx={{ pb: 1 }}>
          <Typography
            variant="subtitle2"
            title={book.title}
            sx={eink ? { whiteSpace: 'normal' } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {book.title}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={eink ? { whiteSpace: 'normal' } : { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {book.authors?.map((a) => a.full_name).join(', ') || '—'}
          </Typography>
          {book.doubles > 0 && (
            <Chip size="small" label={`+${book.doubles} dup`} sx={{ ml: 0.5 }} />
          )}
        </CardContent>
      </CardActionArea>
      <Box sx={{ px: 1.5, pb: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Download
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.25 }}>
          {ALL_FORMATS.map((fmt) => (
            <Button
              key={fmt}
              size="small"
              variant={fmt === book.format ? 'contained' : 'outlined'}
              sx={{
                minWidth: 0,
                px: 1,
                py: eink ? 0.5 : 0.25,
                fontSize: eink ? 13 : 11,
                lineHeight: 1.6,
              }}
              href={`${bookDownloadUrl(book.id)}?format=${fmt}`}
              title={
                fmt === book.format
                  ? `Original ${fmt.toUpperCase()}`
                  : `Convert to ${fmt.toUpperCase()}`
              }
            >
              {fmt}
            </Button>
          ))}
        </Box>
      </Box>
    </Card>
  );
}

export function BookGrid({ books }) {
  const { eink } = useContext(EinkContext);
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: eink
          ? { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' }
          : {
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
