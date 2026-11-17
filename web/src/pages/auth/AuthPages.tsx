import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { api, errorMessage, unwrap } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const DEMO_ACCOUNTS = ['admin', 'manager', 'sales', 'viewer'] as const;
const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS !== 'false';

function AuthShell({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer: ReactNode }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/" replace />;
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle><h1 className="text-xl">{title}</h1></CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">{footer}</CardFooter>
      </Card>
    </div>
  );
}

function Field({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} required {...props} />
    </div>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p>;
}

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) => unwrap(api.POST('/auth/login', { body })),
    onSuccess: (data) => signIn(data.token),
    meta: { inlineError: true },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };

  return (
    <AuthShell
      title="Sign in"
      description="B2B order management"
      footer={<span>New here? <Link className="text-foreground underline underline-offset-4" to="/register">Create an organization</Link></span>}
    >
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <FormError error={login.error} />
        <Button type="submit" disabled={login.isPending}>{login.isPending ? 'Signing in…' : 'Sign in'}</Button>
      </form>

      {SHOW_DEMO && (
        <div className="mt-6 border-t pt-4">
          <p className="mb-2 text-xs text-muted-foreground">Demo accounts (password <code>Password123!</code>):</p>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((role) => (
              <Button
                key={role}
                type="button"
                variant="outline"
                size="sm"
                disabled={login.isPending}
                onClick={() => login.mutate({ email: `${role}@acme.example`, password: 'Password123!' })}
              >
                {role[0]!.toUpperCase() + role.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      )}
    </AuthShell>
  );
}

export function RegisterPage() {
  const { signIn } = useAuth();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const register = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/register', { body: form })),
    onSuccess: (data) => signIn(data.token),
    meta: { inlineError: true },
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AuthShell
      title="Create your organization"
      description="You'll be its first admin and can invite your team."
      footer={<span>Already have an account? <Link className="text-foreground underline underline-offset-4" to="/login">Sign in</Link></span>}
    >
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); register.mutate(); }}>
        <Field id="organizationName" label="Company name" autoComplete="organization" value={form.organizationName} onChange={set('organizationName')} />
        <Field id="name" label="Your name" autoComplete="name" value={form.name} onChange={set('name')} />
        <Field id="email" label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} />
        <FormError error={register.error} />
        <Button type="submit" disabled={register.isPending}>{register.isPending ? 'Creating…' : 'Create organization'}</Button>
      </form>
    </AuthShell>
  );
}
