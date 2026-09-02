import React from 'react';
import { useParams, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useApi, bookCoverUrl, bookDownloadUrl } from '../api.js';
import { Async, Crumbs } from '../components/common.jsx';

export default function BookDetail() {
  const { id } = useParams();
  const query = useApi(`/books/${id}`, [id]);

  return (
    <Async query={query}>
      {(book) => (
        <Box>
          <Crumbs items={[{ label: 'Books', to: '/books' }, { label: book.title }]} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
            <Box
              component="img"
              src={bookCoverUrl(book.id)}
              alt=""
              sx={{
                width: 220,
                maxWidth: '100%',
                borderRadius: 2,
                bgcolor: 'action.hover',
                alignSelf: { xs: 'center', sm: 'flex-start' },
              }}
            />
            <Box sx={{ flexGrow: 1 }}>
              <Typography variant="h5" gutterBottom>
                {book.title}
              </Typography>

              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }}>
                {book.authors.map((a) => (
                  <Chip
                    key={a.id}
                    label={a.full_name}
                    component={RouterLink}
                    to={`/authors/${a.id}`}
                    clickable
                  />
                ))}
              </Stack>

              {book.series.map((s) => (
                <Typography key={s.id} variant="body2" sx={{ mb: 0.5 }}>
                  Series:{' '}
                  <RouterLink to={`/series/${s.id}`}>{s.ser}</RouterLink>
                  {s.ser_no ? ` #${s.ser_no}` : ''}
                </Typography>
              ))}

              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', my: 1 }}>
                {book.genres.map((g) => (
                  <Chip key={g.id} size="small" variant="outlined" label={g.subsection} />
                ))}
              </Stack>

              <Typography variant="body2" color="text.secondary">
                {book.format?.toUpperCase()} · {Math.round((book.filesize || 0) / 1024)} KB
                {book.doc_date ? ` · ${book.doc_date}` : ''}
                {book.lang ? ` · ${book.lang}` : ''}
              </Typography>

              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                <Button
                  variant="contained"
                  startIcon={<DownloadIcon />}
                  href={bookDownloadUrl(book.id)}
                >
                  {book.format?.toUpperCase()}
                </Button>
                <Button variant="outlined" href={bookDownloadUrl(book.id, true)}>
                  ZIP
                </Button>
              </Stack>

              {book.annotation && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                    {book.annotation}
                  </Typography>
                </>
              )}
            </Box>
          </Stack>
        </Box>
      )}
    </Async>
  );
}
