import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { networksApi, type NewNetworkInput, type PublicNetwork } from '../services/api'

export const NETWORKS_KEY = ['networks'] as const

export function NetworksPage() {
  const { can } = useAuth()
  const canManage = can('networks:manage')
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })

  return (
    <section className="max-w-5xl">
      <h1 className="text-2xl font-semibold">Networks</h1>
      <p className="mt-1 text-slate-600">
        Network blockchain dan aset yang dipantau. URL RPC disimpan di konfigurasi server, bukan di
        database. Di sini hanya ditampilkan nama env var-nya.
      </p>

      {canManage && <CreateNetworkForm />}

      <ErrorMessage error={networks.error} />
      {networks.isLoading && <p className="mt-6 text-sm text-slate-500">Memuat…</p>}
      <div className="mt-6 space-y-4">
        {networks.data?.map((network) => (
          <NetworkCard key={network.id} network={network} canManage={canManage} />
        ))}
        {networks.data?.length === 0 && (
          <p className="text-sm text-slate-500">
            Belum ada network. Jalankan seed atau tambah network.
          </p>
        )}
      </div>
    </section>
  )
}

function NetworkCard({ network, canManage }: { network: PublicNetwork; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [addingToken, setAddingToken] = useState(false)
  const toggle = useMutation({
    mutationFn: () =>
      networksApi.update(network.id, {
        status: network.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NETWORKS_KEY }),
  })

  return (
    <article
      aria-label={network.displayName}
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">
            {network.displayName}{' '}
            <span className="font-mono text-xs font-normal text-slate-500">{network.name}</span>
          </h2>
          <p className="mt-1 flex flex-wrap gap-2 text-xs">
            <Badge tone={network.isTestnet ? 'blue' : 'red'}>
              {network.isTestnet ? 'Testnet' : 'MAINNET'}
            </Badge>
            <Badge tone={network.status === 'ACTIVE' ? 'green' : 'slate'}>{network.status}</Badge>
            <span className="text-slate-500">
              {network.chainType} · chainId {network.chainId ?? '—'}
            </span>
            <span className={network.rpcConfigured ? 'text-emerald-700' : 'text-amber-700'}>
              RPC {network.rpcUrlEnv ?? '(tidak diset)'}:{' '}
              {network.rpcConfigured ? 'terkonfigurasi' : 'belum ada di env server'}
            </span>
          </p>
        </div>
        {canManage && (
          <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {network.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
          </Button>
        )}
      </header>
      <ErrorMessage error={toggle.error} />

      <table className="mt-4 w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-1">Aset</th>
            <th className="py-1">Desimal</th>
            <th className="py-1">Kontrak</th>
          </tr>
        </thead>
        <tbody>
          {network.assets.map((asset) => (
            <tr key={asset.id} className="border-t border-slate-100">
              <td className="py-1.5">
                <span className="font-medium">{asset.symbol}</span>{' '}
                <span className="text-slate-500">{asset.name}</span>
              </td>
              <td className="py-1.5">{asset.decimals}</td>
              <td className="py-1.5 font-mono text-xs">
                {asset.isNative ? 'native' : asset.contractAddress}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage &&
        (addingToken ? (
          <AddTokenForm networkId={network.id} onDone={() => setAddingToken(false)} />
        ) : (
          <Button variant="secondary" className="mt-3" onClick={() => setAddingToken(true)}>
            Tambah token ERC-20
          </Button>
        ))}
    </article>
  )
}

function AddTokenForm({ networkId, onDone }: { networkId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ contractAddress: '', symbol: '', name: '', decimals: '18' })
  const add = useMutation({
    mutationFn: () => networksApi.addToken(networkId, { ...form, decimals: Number(form.decimals) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: NETWORKS_KEY })
      onDone()
    },
  })
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value })

  return (
    <form
      aria-label="Tambah token"
      onSubmit={(e) => {
        e.preventDefault()
        add.mutate()
      }}
      className="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2"
    >
      <Field
        label="Alamat kontrak"
        required
        value={form.contractAddress}
        onChange={set('contractAddress')}
      />
      <Field label="Simbol" required value={form.symbol} onChange={set('symbol')} />
      <Field label="Nama" required value={form.name} onChange={set('name')} />
      <Field
        label="Desimal"
        type="number"
        min={0}
        max={36}
        required
        value={form.decimals}
        onChange={set('decimals')}
      />
      <div className="sm:col-span-2">
        <ErrorMessage error={add.error} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={add.isPending}>
          Simpan token
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Batal
        </Button>
      </div>
    </form>
  )
}

function CreateNetworkForm() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const empty = {
    name: '',
    displayName: '',
    chainId: '',
    rpcUrlEnv: '',
    explorerUrl: '',
    nativeSymbol: 'ETH',
    nativeName: '',
    nativeDecimals: '18',
  }
  const [form, setForm] = useState(empty)
  const create = useMutation({
    mutationFn: (input: NewNetworkInput) => networksApi.create(input),
    onSuccess: async () => {
      setForm(empty)
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: NETWORKS_KEY })
    },
  })
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value })

  if (!open) {
    return (
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Tambah network
      </Button>
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    create.mutate({
      name: form.name.trim(),
      displayName: form.displayName.trim(),
      chainType: 'EVM',
      chainId: Number(form.chainId),
      // UI creates testnets only; mainnet requires NETWORK_MODE=mainnet and is done deliberately.
      isTestnet: true,
      rpcUrlEnv: form.rpcUrlEnv.trim() || null,
      explorerUrl: form.explorerUrl.trim() || null,
      nativeAsset: {
        symbol: form.nativeSymbol.trim(),
        name: form.nativeName.trim(),
        decimals: Number(form.nativeDecimals),
      },
    })
  }

  return (
    <form
      aria-label="Tambah network"
      onSubmit={onSubmit}
      className="mt-4 grid max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2"
    >
      <Field
        label="Nama (slug)"
        placeholder="holesky"
        required
        value={form.name}
        onChange={set('name')}
      />
      <Field
        label="Nama tampilan"
        placeholder="Ethereum Holesky (testnet)"
        required
        value={form.displayName}
        onChange={set('displayName')}
      />
      <Field
        label="Chain ID (EVM)"
        type="number"
        min={1}
        required
        value={form.chainId}
        onChange={set('chainId')}
      />
      <Field
        label="Env var RPC"
        placeholder="HOLESKY_RPC_URL"
        hint="Nama variabel di .env server, bukan URL-nya."
        value={form.rpcUrlEnv}
        onChange={set('rpcUrlEnv')}
      />
      <Field
        label="URL explorer"
        placeholder="https://holesky.etherscan.io"
        value={form.explorerUrl}
        onChange={set('explorerUrl')}
      />
      <Field
        label="Simbol aset native"
        required
        value={form.nativeSymbol}
        onChange={set('nativeSymbol')}
      />
      <Field
        label="Nama aset native"
        placeholder="Holesky Ether"
        required
        value={form.nativeName}
        onChange={set('nativeName')}
      />
      <Field
        label="Desimal aset native"
        type="number"
        min={0}
        max={36}
        required
        value={form.nativeDecimals}
        onChange={set('nativeDecimals')}
      />
      <p className="text-xs text-slate-500 sm:col-span-2">
        Hanya network testnet yang bisa ditambahkan dari sini (aturan keras #10).
      </p>
      <div className="sm:col-span-2">
        <ErrorMessage error={create.error} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          Simpan network
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Batal
        </Button>
      </div>
    </form>
  )
}
