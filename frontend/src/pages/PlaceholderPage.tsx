import type { NavItem } from '../navigation'

export function PlaceholderPage({ item }: { item: NavItem }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{item.label}</h1>
      <p className="mt-1 text-slate-600">{item.description}</p>
      <p className="mt-6 inline-block rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500">
        Halaman ini dibangun di Fase {item.phase}.
      </p>
    </section>
  )
}
