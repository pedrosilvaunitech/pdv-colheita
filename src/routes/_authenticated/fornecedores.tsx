import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/fornecedores')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/_authenticated/fornecedores"!</div>
}
