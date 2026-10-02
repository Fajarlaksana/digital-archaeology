import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { CLI_ONLY_ROLES, ROLES, type RoleName } from '@da/shared/rbac'
import { useAuth } from '../auth/useAuth'
import { Button, ErrorMessage, Field } from '../components/ui'
import { usersApi, type PublicUser, type UserStatus } from '../services/api'

const USERS_KEY = ['users'] as const
/** Roles an ADMIN may grant from the UI. SUPER_ADMIN is CLI-only (ADR-003). */
export const GRANTABLE_ROLES = ROLES.filter((role) => !CLI_ONLY_ROLES.includes(role))

export function UsersPage() {
  const { me, can } = useAuth()
  const canManage = can('users:manage')
  const users = useQuery({ queryKey: USERS_KEY, queryFn: usersApi.list })

  return (
    <section className="max-w-5xl">
      <h1 className="text-2xl font-semibold">Users</h1>
      <p className="mt-1 text-slate-600">
        Akun pengguna dan role. Akun SUPER_ADMIN hanya bisa dibuat dan diubah dari CLI server.
      </p>

      {canManage && <CreateUserForm />}

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        {users.isLoading && <p className="p-4 text-sm text-slate-500">Memuat…</p>}
        <ErrorMessage error={users.error} />
        {users.data && (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Pengguna</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">MFA</th>
                <th className="px-4 py-2">Login terakhir</th>
                {canManage && <th className="px-4 py-2">Aksi</th>}
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  canManage={canManage}
                  isSelf={user.id === me?.user.id}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function RoleCheckboxes({
  value,
  onChange,
}: {
  value: RoleName[]
  onChange: (roles: RoleName[]) => void
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {GRANTABLE_ROLES.map((role) => (
        <label key={role} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={value.includes(role)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, role] : value.filter((r) => r !== role))
            }
          />
          {role}
        </label>
      ))}
    </div>
  )
}

function CreateUserForm() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', password: '' })
  const [roles, setRoles] = useState<RoleName[]>(['ANALYST'])
  const create = useMutation({
    mutationFn: usersApi.create,
    onSuccess: async () => {
      setForm({ email: '', name: '', password: '' })
      setRoles(['ANALYST'])
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: USERS_KEY })
    },
  })

  if (!open) {
    return (
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Tambah user
      </Button>
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    create.mutate({ ...form, roles })
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Tambah user"
      className="mt-4 max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <Field
        label="Email"
        type="email"
        required
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
      />
      <Field
        label="Nama"
        required
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <Field
        label="Password awal"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        hint="Minimal 12 karakter. Sampaikan ke pengguna lewat jalur aman."
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">Role</legend>
        <RoleCheckboxes value={roles} onChange={setRoles} />
      </fieldset>
      <ErrorMessage error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending || roles.length === 0}>
          Simpan
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Batal
        </Button>
      </div>
    </form>
  )
}

function UserRow({
  user,
  canManage,
  isSelf,
}: {
  user: PublicUser
  canManage: boolean
  isSelf: boolean
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [roles, setRoles] = useState<RoleName[]>(user.roles)
  const update = useMutation({
    mutationFn: (input: { roles?: RoleName[]; status?: UserStatus }) =>
      usersApi.update(user.id, input),
    onSuccess: async () => {
      setEditing(false)
      await queryClient.invalidateQueries({ queryKey: USERS_KEY })
    },
  })

  const cliOnly = user.roles.some((role) => CLI_ONLY_ROLES.includes(role))
  const locked = isSelf || cliOnly
  const lockReason = isSelf ? 'Tidak bisa mengubah akun sendiri' : 'Hanya lewat CLI server'

  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      <td className="px-4 py-3">
        <p className="font-medium">{user.name}</p>
        <p className="text-xs text-slate-500">{user.email}</p>
      </td>
      <td className="px-4 py-3">
        {editing ? <RoleCheckboxes value={roles} onChange={setRoles} /> : user.roles.join(', ')}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={user.status} />
      </td>
      <td className="px-4 py-3">{user.mfaEnabled ? 'Aktif' : '—'}</td>
      <td className="px-4 py-3 text-xs text-slate-500">
        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('id-ID') : 'Belum pernah'}
      </td>
      {canManage && (
        <td className="px-4 py-3">
          {locked ? (
            <span className="text-xs text-slate-400">{lockReason}</span>
          ) : editing ? (
            <div className="flex gap-2">
              <Button
                disabled={update.isPending || roles.length === 0}
                onClick={() => update.mutate({ roles })}
              >
                Simpan
              </Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Batal
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Ubah role
              </Button>
              {user.status === 'ACTIVE' ? (
                <Button variant="secondary" onClick={() => update.mutate({ status: 'DISABLED' })}>
                  Nonaktifkan
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => update.mutate({ status: 'ACTIVE' })}>
                  {user.status === 'LOCKED' ? 'Buka kunci' : 'Aktifkan'}
                </Button>
              )}
            </div>
          )}
          <ErrorMessage error={update.error} />
        </td>
      )}
    </tr>
  )
}

function StatusBadge({ status }: { status: UserStatus }) {
  const tone = {
    ACTIVE: 'bg-emerald-50 text-emerald-700',
    DISABLED: 'bg-slate-100 text-slate-600',
    LOCKED: 'bg-amber-50 text-amber-700',
  }[status]
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
}
