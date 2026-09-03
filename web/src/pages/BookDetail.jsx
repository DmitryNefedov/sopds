import React, { useContext } from 'react';
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
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useApi, bookCoverUrl, bookDownloadUrl } from '../api.js';
import { Async, Crumbs } from '../components/common.jsx';
import { EinkContext } from '../main.jsx';

const ALL_FORMATS = ['fb2', 'epub', 'mobi'];

export default function BookDetail() {
  const { id } = useParams();
  const { eink } = useContext(EinkContext);
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
                width: eink ? 200 : 220,
                maxWidth: '100%',
                borderRadius: 2,
                border: eink ? '1px solid' : 'none',
                borderColor: 'divider',
                bgcolor: eink ? 'grey.300' : 'action.hover',
                filter: eink ? 'grayscale(1) contrast(1.06)' : 'none',
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

              <Typography variant="overline" color="text.secondary">
                Download
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 1 }}>
                {ALL_FORMATS.map((fmt) => {
                  const native = fmt === book.format;
                  return (
                    <Button
                      key={fmt}
                      variant={native ? 'contained' : 'outlined'}
                      startIcon={native ? <DownloadIcon /> : <AutoFixHighIcon />}
                      href={`${bookDownloadUrl(book.id)}?format=${fmt}`}
                      title={
                        native
                          ? `Original ${fmt.toUpperCase()} file`
                          : `Convert ${book.format?.toUpperCase()} → ${fmt.toUpperCase()} and download`
                      }
                    >
                      {fmt.toUpperCase()}
                    </Button>
                  );
                })}
                <Button
                  variant="text"
                  href={`${bookDownloadUrl(book.id)}?format=${book.format}&zip=1`}
                >
                  ZIP
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Non-native formats are converted on the fly.
              </Typography>

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
