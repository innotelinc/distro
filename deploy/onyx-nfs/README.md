# The onyx shares the Distro pools are built on

Two files, two machines. The pools live on onyx's disks; the control plane runs in
a container that cannot mount anything, so the same tree has to be exported by
onyx and mounted by the host that runs Docker. Nothing here is installed by
`bootstrap.sh` — this is the pair of hand-made configs that made the pools work,
kept in the repo so a rebuilt host reproduces them instead of finding them.

| file | lives on | path there |
| --- | --- | --- |
| `ganesha.conf` | `i3move:onyx` (192.168.1.60) | `/etc/ganesha/ganesha.conf` |
| `fstab.onyx` | the host running the control plane | appended to `/etc/fstab` |

Both are byte-identical to what those hosts run, so `diff` against the live file
is a real check and not a formatting argument.

## Why it is shaped this way

- **Ganesha, not `exportfs`.** Both boxes are LXC containers; the kernel NFS
  server refuses to export (`exportfs: does not support NFS export`, it needs
  `CAP_SYS_ADMIN` on the host). NFS-Ganesha serves the same exports from
  userspace, so `ganesha.conf` — not `/etc/exports` — is the table that matters,
  and `exportfs -v` answering nothing is not a fault.
- **Two sibling exports, never nested.** A pseudo parent (`/mnt/onyx`) with a
  pseudo child (`/mnt/onyx/main-pool`) fails on this kernel: ganesha's VFS FSAL
  cannot build the parent node for a child that is itself a mount point, and
  `nfsd` exits with `LOOKUP main-pool failed with Undefined server error`.
  Exporting the two shares as siblings avoids the lookup entirely.
- **`sdc` is `main-pool`.** Onyx records the operator's share *and* the device
  reconciler's own row, both naming the same export. The reconciler keeps that
  row with `INSERT OR IGNORE … source = 'device:<kname>'` on every pass while the
  disk is mounted (`services/core/devices.go`), so deleting the share only lasts
  until the next pass — it cannot be pruned. Mounting one export twice is the
  same bytes with one server-side export, so the pool the console calls `sdc` is
  a bind of `main-pool`; that is deliberate, not a duplicate waiting to be
  cleaned up.
- **NFSv3.** NFSv4 mounts and even writes succeed against this build, but
  `READDIR` returns `EIO`: `ls` on a fresh v4 mount fails with "Remote I/O error"
  while creating a file in the same directory works, which reads as a
  permissions problem and is not one. Every entry is `vers=3`.
- **`soft` and `nofail`.** A `hard` mount to a powered-off onyx hangs every
  process that touches the path, including Docker's own startup; `soft` returns
  an error to the caller instead. `nofail` keeps the host booting, and the
  storage page then says the pool is not mounted rather than showing a directory
  that looks empty.

The `.mount` units are not shipped: systemd generates
`srv-onyx\x2dpool-main\x2dpool.mount`, `…-onyx\x2ddata.mount` and `…-sdc.mount`
from the fstab lines on the next `daemon-reload`. Shipping hand-written units
beside the fstab lines would give the same path two owners.

## Installing it on a host

On onyx, once:

```
install -m 0644 deploy/onyx-nfs/ganesha.conf /etc/ganesha/ganesha.conf
systemctl restart nfs-ganesha
```

On the host that runs the control plane:

```
# once: appending the block twice gives the same path two fstab entries
cat deploy/onyx-nfs/fstab.onyx >> /etc/fstab
install -d /srv/onyx-pool/main-pool /srv/onyx-pool/sdc /srv/onyx-pool/onyx-data
systemctl daemon-reload
# by mount point, not by unit name: systemd escapes the dashes in
# `srv-onyx\x2dpool-main\x2dpool.mount`, and the unescaped form is not found
for t in /srv/onyx-pool/main-pool /srv/onyx-pool/onyx-data /srv/onyx-pool/sdc; do mount "$t"; done
```

`docker-compose.yml` then carries the whole tree in with
`/srv/onyx-pool:/data/pools:rslave`, and the storage adapter checks the mount
table before it writes, so an unmounted pool reports "not mounted at …" instead
of writing into the empty directory underneath the mount point.

## Checking it

```
# on the host: all three mounted, fstype nfs
systemctl list-units --type=mount --no-pager | grep srv-onyx

# in the control-plane container: the bind reached it, and each pool is a mount
docker inspect --format '{{range .Mounts}}{{.Source}} => {{.Destination}} {{.Propagation}}{{"\n"}}{{end}}' distro-control-plane
docker exec distro-control-plane sh -c 'for p in main-pool onyx-data sdc; do stat -f -c "%n %T" /data/pools/$p; done'
```

`/admin` → **Pools** → **Sync now** runs the same pass the timer does; each pool
that answers carries a write/read/delete through `probePool`, which is what the
green status line means.
