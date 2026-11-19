import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage, unwrap } from '@/api/client';
import { USER_ROLES, type User, type UserRole } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, TableSkeleton } from '@/components/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { capitalize, formatBps, formatDate, formatMoney, parsePercentToBps, SUPPORTED_CURRENCIES, todayIn } from '@/lib/format';

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
  const { api, can, me } = useAuth();
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
    onSuccess: (_d, user) => { refresh(); toast.success(user.status === 'invited' ? `Invitation for ${user.email} cancelled` : `${user.name} was deactivated`); },
  });
  const resend = useMutation({
    mutationFn: (user: User) => unwrap(api.POST('/users/{id}/resend-invitation', { params: { path: { id: user.id } } })),
    onSuccess: (u) => toast.success(`New invitation sent to ${u.email}. Earlier links no longer work.`),
  });

  return (
    <>
      <PageHeader
        title="Team"
        description="People in your organization and what they can do."
        actions={canWrite && <Button onClick={() => setInviting(true)}><Plus /> Invite member</Button>}
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
                    <TableCell className="hidden md:table-cell">
                      {u.status === 'invited' ? <Badge variant="secondary">Invited</Badge> : formatDate(u.createdAt)}
                    </TableCell>
                    {canWrite && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {u.status === 'invited' && (
                            <Button variant="ghost" size="sm" disabled={resend.isPending} aria-label={`Resend invitation to ${u.email}`}
                              onClick={() => resend.mutate(u)}>Resend invite</Button>
                          )}
                          {!isSelf && (u.status === 'invited' ? (
                            <ConfirmDialog
                              trigger={<Button variant="ghost" size="sm" aria-label={`Cancel invitation for ${u.email}`}>Cancel invite</Button>}
                              title={`Cancel the invitation for ${u.email}?`}
                              description="Their invitation link stops working right away."
                              confirmLabel="Cancel invitation"
                              destructive
                              onConfirm={() => deactivate.mutate(u)}
                            />
                          ) : (
                            <ConfirmDialog
                              trigger={<Button variant="ghost" size="sm">Deactivate</Button>}
                              title={`Deactivate ${u.name}?`}
                              description="They lose access immediately. Their quotes, orders and history are kept."
                              confirmLabel="Deactivate"
                              destructive
                              onConfirm={() => deactivate.mutate(u)}
                            />
                          ))}
                        </div>
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

      <OrganizationSettings />

      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={refresh} />}
    </>
  );
}

const TIME_ZONES: string[] = (() => {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
  } catch {
    return ['UTC'];
  }
})();

function OrganizationSettings() {
  const { api, can, me } = useAuth();
  const queryClient = useQueryClient();
  const org = me?.organization;
  const [form, setForm] = useState({
    name: org?.name ?? '',
    timezone: org?.timezone ?? 'UTC',
    maxDiscount: String((org?.maxDiscountBps ?? 0) / 100),
    currency: org?.currency ?? 'USD',
  });
  const currency = form.currency.trim().toUpperCase();
  const currencyValid = SUPPORTED_CURRENCIES.includes(currency);
  const maxDiscountBps = parsePercentToBps(form.maxDiscount);
  const canWrite = can('organization:write');
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH('/organization', {
      body: { name: form.name.trim(), timezone: form.timezone.trim(), maxDiscountBps: maxDiscountBps!, currency },
    })),
    onSuccess: (saved) => {
      // Adopt the server's canonical values (e.g. "america/new_york" -> "America/New_York") so the form is clean again.
      setForm({ name: saved.name, timezone: saved.timezone, maxDiscount: String(saved.maxDiscountBps / 100), currency: saved.currency });
      // The zone changes which sent quotes count as expired, so refresh quotes along with the account.
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast.success(`Saved. Quote validity now follows ${saved.timezone} time.`);
    },
    meta: { inlineError: true },
  });
  if (!org) return null;
  const dirty = form.name.trim() !== org.name || form.timezone.trim() !== org.timezone || maxDiscountBps !== org.maxDiscountBps
    || currency !== org.currency;
  const valid = maxDiscountBps !== null && currencyValid;
  const submit = (e: FormEvent) => { e.preventDefault(); if (dirty && valid) save.mutate(); };

  return (
    <Card className="mt-8 max-w-2xl">
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          Quotes stay valid through the end of their "valid until" date in this time zone.
          It's {todayIn(org.timezone)} there now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <FormField id="org-name" label="Name">
            <Input id="org-name" required maxLength={200} disabled={!canWrite} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField id="org-timezone" label="Time zone" hint={canWrite ? 'Type to search, e.g. Asia/Shanghai.' : 'Only admins can change this.'}>
            <Input id="org-timezone" required list="org-timezones" maxLength={64} disabled={!canWrite} value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            <datalist id="org-timezones">{TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
          </FormField>
          <FormField id="org-currency" label="Base currency"
            error={currencyValid ? null : 'Enter a currency with two decimal places, such as USD, EUR or GBP'}
            hint={currency !== org.currency
              ? `Catalog prices are not converted: ${formatMoney(10_000, org.currency)} will read as ${formatMoney(10_000, currencyValid ? currency : org.currency)}.`
              : 'Catalog prices are in this currency. Sales reps can only quote and order in it.'}>
            <Input id="org-currency" required maxLength={3} list="org-currencies" disabled={!canWrite} value={form.currency} className="uppercase"
              aria-invalid={!currencyValid} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            <datalist id="org-currencies">{SUPPORTED_CURRENCIES.map((code) => <option key={code} value={code} />)}</datalist>
          </FormField>
          <FormField id="org-max-discount" label="Sales discount limit (%)"
            error={maxDiscountBps === null ? 'Enter a percentage between 0 and 100' : null}
            hint={`Most a sales rep can take off catalog prices (now ${formatBps(org.maxDiscountBps)}). Managers and admins aren't limited.`}>
            <Input id="org-max-discount" inputMode="decimal" required disabled={!canWrite} value={form.maxDiscount}
              aria-invalid={maxDiscountBps === null} onChange={(e) => setForm({ ...form, maxDiscount: e.target.value })} />
          </FormField>
          {save.error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{errorMessage(save.error)}</p>}
          {canWrite && (
            <div className="sm:col-span-2">
              <Button type="submit" disabled={!dirty || !valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'sales' as UserRole });
  // Emailing an invitation is the default; an initial password is the fallback when email isn't available.
  const [withPassword, setWithPassword] = useState(false);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/users', { body: { ...form, password: withPassword ? form.password : undefined } })),
    onSuccess: (u) => {
      onDone();
      toast.success(u.status === 'invited' ? `Invitation sent to ${u.email}` : `${u.name} added. Share their password with them securely.`);
      onClose();
    },
    meta: { inlineError: true },
  });
  const emailUnavailable = create.error instanceof ApiError && create.error.code === 'EMAIL_UNAVAILABLE';
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Invite team member</DialogTitle></DialogHeader>
        <form id="invite-form" className="grid gap-4" onSubmit={submit}>
          <FormField id="invite-name" label="Name">
            <Input id="invite-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </FormField>
          <FormField id="invite-email" label="Email">
            <Input id="invite-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </FormField>
          {withPassword ? (
            <FormField id="invite-password" label="Initial password" hint="At least 8 characters. Share it with them securely.">
              <Input id="invite-password" type="password" required minLength={8} autoComplete="new-password" value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </FormField>
          ) : (
            <p className="text-xs text-muted-foreground">
              We'll email them a link to choose their own password. It expires in 7 days.
            </p>
          )}
          <FormField id="invite-role" label="Role" hint={ROLE_DESCRIPTIONS[form.role]}>
            <RoleSelect id="invite-role" value={form.role} onChange={(role) => setForm({ ...form, role })} />
          </FormField>
        </form>
        {create.error && <p role="alert" className="text-sm text-destructive">{errorMessage(create.error)}</p>}
        <DialogFooter className="sm:justify-between">
          <Button variant="link" className="px-0" onClick={() => { setWithPassword(!withPassword); create.reset(); }}>
            {withPassword ? 'Email an invitation instead' : emailUnavailable ? 'Set an initial password' : 'Set a password instead'}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="invite-form" disabled={create.isPending}>
              {create.isPending ? (withPassword ? 'Adding…' : 'Sending…') : withPassword ? 'Add member' : 'Send invitation'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
