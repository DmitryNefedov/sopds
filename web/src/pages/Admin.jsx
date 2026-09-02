import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { apiGet, apiSend } from '../api.js';
import { Loading, ErrorState } from '../components/common.jsx';

const CRON_PRESETS = [
  { label: 'Twice daily (00:00, 12:00)', value: '0 0,12 * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Nightly (03:00)', value: '0 3 * * *' },
  { label: 'Every 15 min', value: '*/15 * * * *' },
  { label: 'Weekly (Mon 04:00)', value: '0 4 * * 1' },
];

function SettingField({ def, value, onChange, error }) {
  if (def.type === 'bool') {
    return (
      <FormControlLabel
        control={
          <Switch checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        }
        label={
          <Box>
            <Typography variant="body2">{def.label}</Typography>
            {def.help && (
              <Typography variant="caption" color="text.secondary">
                {def.help}
              </Typography>
            )}
          </Box>
        }
        sx={{ alignItems: 'flex-start', mt: 1 }}
      />
    );
  }
  return (
    <Box sx={{ mt: 2 }}>
      <TextField
        fullWidth
        size="small"
        type={def.type === 'int' ? 'number' : 'text'}
        label={def.label}
        value={value ?? ''}
        error={!!error}
        helperText={error || def.help || ''}
        onChange={(e) =>
          onChange(def.type === 'int' ? e.target.value : e.target.value)
        }
        inputProps={def.type === 'int' ? { min: def.min, max: def.max } : undefined}
      />
      {def.key === 'scanCron' && (
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
          {CRON_PRESETS.map((p) => (
            <Chip
              key={p.value}
              size="small"
              label={p.label}
              variant={value === p.value ? 'filled' : 'outlined'}
              color={value === p.value ? 'primary' : 'default'}
              onClick={() => onChange(p.value)}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ScanPanel({ scan, onScan, scanning }) {
  const last = scan?.last;
  const watch = scan?.watch;
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h6">Library scan</Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
              <Chip
                size="small"
                variant="outlined"
                color={scan?.running ? 'warning' : 'default'}
                label={scan?.running ? 'Scanning now…' : 'Idle'}
              />
              <Chip
                size="small"
                variant="outlined"
                color={scan?.enabled ? 'success' : 'default'}
                label={scan?.enabled ? `Scheduled: ${scan.cron}` : 'No schedule'}
              />
              {watch && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={watch.watching ? 'success' : 'default'}
                  label={
                    watch.watching
                      ? watch.pending
                        ? 'Watching · change detected…'
                        : `Watching ${watch.watchedDirs} folder(s)`
                      : 'Not watching'
                  }
                />
              )}
            </Stack>
          </Box>
          <Button
            variant="contained"
            startIcon={scanning ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
            disabled={scanning || scan?.running}
            onClick={onScan}
          >
            Scan now
          </Button>
        </Stack>
        {last && (
          <Alert
            severity={last.error ? 'error' : 'success'}
            sx={{ mt: 2 }}
            variant="outlined"
          >
            {last.error ? (
              <>Last scan failed: {last.error}</>
            ) : (
              <>
                Last scan ({last.reason}) {new Date(last.finishedAt).toLocaleString()}:{' '}
                <strong>{last.added}</strong> added, <strong>{last.skipped}</strong>{' '}
                unchanged, <strong>{last.removed}</strong> removed
                {last.bad ? `, ${last.bad} unreadable` : ''}
                {last.archives ? `, ${last.archives} archives` : ''}
              </>
            )}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export default function Admin() {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [draft, setDraft] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState(null);

  const load = () => {
    setLoadErr(null);
    Promise.all([apiGet('/admin/settings'), apiGet('/admin/scan')])
      .then(([settings, scan]) => {
        setData({ ...settings, scan });
        setDraft(settings.values);
      })
      .catch(setLoadErr);
  };
  useEffect(load, []);

  // Keep the scan / watch status fresh while the page is open.
  useEffect(() => {
    const id = setInterval(() => {
      apiGet('/admin/scan')
        .then((scan) => setData((d) => (d ? { ...d, scan } : d)))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const dirty = useMemo(() => {
    if (!data) return false;
    return Object.keys(draft).some((k) => draft[k] !== data.values[k]);
  }, [draft, data]);

  const save = async () => {
    setSaving(true);
    setFieldErrors({});
    try {
      const changed = Object.fromEntries(
        Object.keys(draft)
          .filter((k) => draft[k] !== data.values[k])
          .map((k) => [k, draft[k]]),
      );
      const res = await apiSend('PUT', '/admin/settings', changed);
      setData((d) => ({ ...d, values: res.values, converter: res.converter, scan: res.scan }));
      setDraft(res.values);
      setToast('Settings saved');
    } catch (err) {
      setFieldErrors(err.fields || {});
      setToast(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await apiSend('POST', '/admin/scan');
      const scan = await apiGet('/admin/scan');
      setData((d) => ({ ...d, scan }));
      setToast(res.error ? `Scan failed: ${res.error}` : `Scan complete: ${res.added} added`);
    } catch (err) {
      setToast(err.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  if (loadErr) return <ErrorState error={loadErr} onRetry={load} />;
  if (!data) return <Loading />;

  return (
    <Box>
      <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Settings
        </Typography>
        <Button startIcon={<RefreshIcon />} onClick={load}>
          Reload
        </Button>
      </Stack>

      {data.auth && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Admin token is enabled on the server.
        </Alert>
      )}

      <ScanPanel scan={data.scan} onScan={runScan} scanning={scanning} />

      {data.groups.map((group) => (
        <Card key={group.group} sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              {group.group}
            </Typography>
            {group.settings.map((def) => (
              <SettingField
                key={def.key}
                def={def}
                value={draft[def.key]}
                error={fieldErrors[def.key]}
                onChange={(v) => setDraft((d) => ({ ...d, [def.key]: v }))}
              />
            ))}
            {group.group === 'Conversion' && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                Active engine: <strong>{data.converter.engine}</strong>
                {data.converter.external ? ` (${data.converter.external})` : ''}
              </Typography>
            )}
          </CardContent>
        </Card>
      ))}

      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          py: 2,
          bgcolor: 'background.default',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 1,
        }}
      >
        <Button disabled={!dirty || saving} onClick={() => setDraft(data.values)}>
          Discard
        </Button>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
          disabled={!dirty || saving}
          onClick={save}
        >
          Save changes
        </Button>
      </Box>

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      />
    </Box>
  );
}
