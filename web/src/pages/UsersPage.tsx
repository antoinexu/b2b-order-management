import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, unwrap } from '@/api/client';
import { USER_ROLES, type User, type UserRole } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, TableSkeleton } from '@/components/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { capitalize, formatDate } from '@/lib/format';

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Full access, including team management',
  manager: 'Catalog, pricing and order fulfilment',
  sales: 'Customers, quotes and orders',
  viewer: 'Read-only access',
};
const roleItems = USER_ROLES.map((r) => ({ value: r, label: capitalize(r) }));

function RoleSelect({ id, value, onChange, disabled }: { id?: string; value: UserRole; onChange: (r: UserRole) => void; disabled?: boolean }) {
  return (
    <Select items={roleItems} value={value} onValueChange={(v) => v && onChange(v as UserRole)} disabled={disabled}>
      <SelectTrigger id={id} className="w-32" aria-label="Role"><SelectValue /></SelectTrigger>
      <SelectContent>
        {USER_ROLES.map((r) => <SelectItem key={r} value={r}>{capitalize(r)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function UsersPage() {
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const canWrite = can('users:write');

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => unwrap(api.GET('/users', { params: { query: { pageSize: 100 } } })),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => unwrap(api.PATCH('/users/{id}', { params: { path: { id } }, body: { role } })),
    onSuccess: (u) => { refresh(); toast.success(`${u.name} is now ${u.role}`); },
  });
  const deactivate = useMutation({
    mutationFn: (user: User) => unwrap(api.DELETE('/users/{id}', { params: { path: { id: user.id } } })),
    onSuccess: (_d, user) => { refresh(); toast.success(`${user.name} was deactivated`); },
  });

  return (
    <>
      <PageHeader
        title="Team"
        description="People in your organization and what they can do."
        actions={canWrite && <Button onClick={() => setInviting(true)}><Plus /> Add member</Button>}
      />
      {users.isPending ? <TableSkeleton /> : users.isError ? <ErrorState error={users.error} onRetry={() => users.refetch()} /> : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Joined</TableHead>
                {canWrite && <TableHead className="w-0" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.data.map((u) => {
                const isSelf = u.id === me?.user.id;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}{isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}</TableCell>
                    <TableCell className="hidden sm:table-cell">{u.email}</TableCell>
                    <TableCell>
                      {canWrite && !isSelf
                        ? <RoleSelect value={u.role} disabled={changeRole.isPending} onChange={(role) => changeRole.mutate({ id: u.id, role })} />
                        : <Badge variant="outline">{capitalize(u.role)}</Badge>}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(u.createdAt)}</TableCell>
                    {canWrite && (
                      <TableCell>
                        {!isSelf && (
                          <ConfirmDialog
                            trigger={<Button variant="ghost" size="sm">Deactivate</Button>}
                            title={`Deactivate ${u.name}?`}
                            description="They lose access immediately. Their quotes, orders and history are kept."
                            confirmLabel="Deactivate"
                            destructive
                            onConfirm={() => deactivate.mutate(u)}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
        {USER_ROLES.map((r) => (
          <p key={r}><span className="font-medium">{capitalize(r)}:</span> <span className="text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</span></p>
        ))}
      </div>

      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={refresh} />}
    </>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'sales' as UserRole });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/users', { body: form })),
    onSuccess: (u) => { onDone(); toast.success(`${u.name} added`); onClose(); },
    meta: { inlineError: true },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add team member</DialogTitle></DialogHeader>
        <form id="invite-form" className="grid gap-4" onSubmit={submit}>
          <FormField id="invite-name" label="Name">
            <Input id="invite-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </FormField>
          <FormField id="invite-email" label="Email">
            <Input id="invite-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </FormField>
          <FormField id="invite-password" label="Temporary password" hint="At least 8 characters. Share it with them securely.">
            <Input id="invite-password" type="password" required minLength={8} autoComplete="new-password" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </FormField>
          <FormField id="invite-role" label="Role" hint={ROLE_DESCRIPTIONS[form.role]}>
            <RoleSelect id="invite-role" value={form.role} onChange={(role) => setForm({ ...form, role })} />
          </FormField>
        </form>
        {create.error && <p role="alert" className="text-sm text-destructive">{errorMessage(create.error)}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="invite-form" disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add member'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
