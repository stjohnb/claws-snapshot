# datasette-export

Exports a snapshot of the Claws SQLite database to a remote host via scp for
Datasette-based data exploration.

**Source**: `src/jobs/datasette-export.ts`

## Behavior

Runs on a configurable interval (default: 6 hours). Only executes when
`datasetteExport` is configured in `config.json`.

### Export process

1. **Check configuration**: If `DATASETTE_EXPORT` is null, skip silently
2. **Create snapshot**: Calls `backupDb()` to create a SQLite backup at
   `~/.claws/claws-datasette-export.db`
3. **Upload**: SCPs the snapshot to the configured remote host and path
4. **Cleanup**: Deletes the local snapshot file in a `finally` block (best effort)

### SCP configuration

The `DatasetteExport` config object specifies:

| Field | Description |
|-------|-------------|
| `host` | Remote host address |
| `user` | SSH username (optional) |
| `port` | SSH port (optional, defaults to 22) |
| `identityFile` | SSH private key path (supports `~` expansion) |
| `remotePath` | Destination path on the remote host |

SCP uses `StrictHostKeyChecking=accept-new` for first-time host key acceptance
and `BatchMode=yes` for non-interactive operation. Timeout is 120 seconds.

## Configuration

Configured via `datasetteExport` in `config.json` (no env var). Example:

```json
{
  "datasetteExport": {
    "host": "192.168.1.100",
    "user": "datasette",
    "identityFile": "~/.ssh/id_ed25519",
    "remotePath": "/var/lib/datasette/claws.db"
  }
}
```

Interval configurable via `intervals.datasetteExportMs` (default: 21600000 = 6 hours).
