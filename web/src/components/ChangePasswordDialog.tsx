import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errorMessage, unwrap } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { api, signIn } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const mismatch = form.confirm !== '' && form.confirm !== form.newPassword;
  const change = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/change-password', {
      body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
    })),
    onSuccess: (data) => {
      toast.success('Password changed. Other sessions were signed out.');
      // The old token is now revoked; switching to the new one starts a fresh session in this tab.
      signIn(data.token);
    },
    meta: { inlineError: true },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) change.mutate();
  };
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>You'll stay signed in here. Every other device and browser will be signed out.</DialogDescription>
        </DialogHeader>
        <form id="change-password-form" className="grid gap-4" onSubmit={submit}>
          <FormField id="current-password" label="Current password">
            <Input id="current-password" type="password" required autoComplete="current-password" autoFocus
              value={form.currentPassword} onChange={set('currentPassword')} />
          </FormField>
          <FormField id="new-password" label="New password" hint="At least 8 characters.">
            <Input id="new-password" type="password" required minLength={8} maxLength={128} autoComplete="new-password"
              value={form.newPassword} onChange={set('newPassword')} />
          </FormField>
          <FormField id="confirm-password" label="Confirm new password" error={mismatch ? "Passwords don't match" : null}>
            <Input id="confirm-password" type="password" required autoComplete="new-password" aria-invalid={mismatch}
              value={form.confirm} onChange={set('confirm')} />
          </FormField>
        </form>
        {change.error && <p role="alert" className="text-sm text-destructive">{errorMessage(change.error)}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="change-password-form" disabled={change.isPending || mismatch}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
