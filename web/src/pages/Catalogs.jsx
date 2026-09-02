import React from 'react';
import { useSearchParams, Link as RouterLink } from 'react-router-dom';
import { Box, List, ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import ArchiveIcon from '@mui/icons-material/Archive';
import { useApi } from '../api.js';
import { Async, BookGrid, Crumbs, Empty, Pager } from '../components/common.jsx';

export default function Catalogs() {
  const [params, setParams] = useSearchParams();
  const cat = params.get('cat');
  const page = Number(params.get('page')) || 1;
  const query = useApi(
    `/catalogs?${cat ? `cat=${cat}&` : ''}page=${page}`,
    [cat, page],
  );

  return (
    <Box>
      <Async query={query}>
        {(data) => (
          <>
            <Crumbs
              items={[
                { label: 'Catalogs', to: '/catalogs' },
                ...data.breadcrumbs.map((b) => ({
                  label: b.name,
                  to: `/catalogs?cat=${b.id}`,
                })),
              ]}
            />
            <Typography variant="h5" gutterBottom>
              Catalogs
            </Typography>
            {data.catalogs.length > 0 && (
              <List>
                {data.catalogs.map((c) => (
                  <ListItemButton
                    key={c.id}
                    component={RouterLink}
                    to={`/catalogs?cat=${c.id}`}
                  >
                    <ListItemIcon>
                      {c.cat_type === 1 ? <ArchiveIcon /> : <FolderIcon />}
                    </ListItemIcon>
                    <ListItemText
                      primary={c.cat_name}
                      secondary={`${c.book_count} book(s)`}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
            {data.books.items.length > 0 ? (
              <Box sx={{ mt: 2 }}>
                <BookGrid books={data.books.items} />
                <Pager
                  meta={data.books}
                  page={page}
                  onChange={(p) =>
                    setParams(cat ? { cat, page: String(p) } : { page: String(p) })
                  }
                />
              </Box>
            ) : (
              data.catalogs.length === 0 && <Empty />
            )}
          </>
        )}
      </Async>
    </Box>
  );
}
