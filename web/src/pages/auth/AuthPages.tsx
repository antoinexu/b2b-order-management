import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage, unwrap } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { browserTimeZone } from '@/lib/format';

const DEMO_ACCOUNTS = ['admin', 'manager', 'sales', 'viewer'] as const;
const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS !== 'false';

const linkClass = 'text-foreground underline underline-offset-4';

function AuthShell({ title, description, children, footer, allowSignedIn = false }: {
  title: string; description: string; children: ReactNode; footer: ReactNode;
  /** Emailed links must work even if this browser is signed in to another account. */
  allowSignedIn?: boolean;
}) {
  const { token } = useAuth();
  if (token && !allowSignedIn) return <Navigate to="/" replace />;
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle><h1 className="text-xl">{title}</h1></CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {token && allowSignedIn && (
            <p role="status" className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              You're signed in to another account in this browser. Continuing signs you in with this one instead.
            </p>
          )}
          {children}
        </CardContent>
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
  const { api, signIn } = useAuth();
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
      footer={<span>New here? <Link className={linkClass} to="/register">Create an organization</Link></span>}
    >
      <form className="grid gap-4" onSubmit={submit}>
        <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Link className="-mt-2 justify-self-end text-xs text-muted-foreground underline underline-offset-4" to="/forgot-password" state={{ email }}>
          Forgot password?
        </Link>
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
  const { api, signIn } = useAuth();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [timezone] = useState(browserTimeZone);
  const register = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/register', { body: { ...form, timezone } })),
    onSuccess: (data) => signIn(data.token),
    meta: { inlineError: true },
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AuthShell
      title="Create your organization"
      description="You'll be its first admin and can invite your team."
      footer={<span>Already have an account? <Link className={linkClass} to="/login">Sign in</Link></span>}
    >
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); register.mutate(); }}>
        <Field id="organizationName" label="Company name" autoComplete="organization" value={form.organizationName} onChange={set('organizationName')} />
        <Field id="name" label="Your name" autoComplete="name" value={form.name} onChange={set('name')} />
        <Field id="email" label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} />
        <p className="text-xs text-muted-foreground">Time zone: {timezone}. Admins can change it later on the Team page.</p>
        <FormError error={register.error} />
        <Button type="submit" disabled={register.isPending}>{register.isPending ? 'Creating…' : 'Create organization'}</Button>
      </form>
    </AuthShell>
  );
}

const backToSignIn = <Link className={linkClass} to="/login">Back to sign in</Link>;

/** The token travels in the URL fragment (`#token=…`), which browsers never send to servers or in Referer headers. */
function useLinkToken() {
  const { hash } = useLocation();
  return new URLSearchParams(hash.slice(1)).get('token');
}

/** Signs in with a token from an emailed link and lands on the dashboard. */
function useSignInAfterLink() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  return (token: string, message: string) => {
    // Leave the link page first: once signed in, this session's pages are replaced by the new account's.
    navigate('/', { replace: true });
    signIn(token);
    toast.success(message);
  };
}

function NewPasswordFields({ password, confirm, onPassword, onConfirm }: {
  password: string; confirm: string; onPassword: (value: string) => void; onConfirm: (value: string) => void;
}) {
  const mismatch = confirm !== '' && confirm !== password;
  return (
    <>
      <Field id="new-password" label="New password" type="password" autoComplete="new-password" minLength={8} maxLength={128}
        value={password} onChange={(e) => onPassword(e.target.value)} />
      <div className="grid gap-1.5">
        <Field id="confirm-password" label="Confirm password" type="password" autoComplete="new-password" minLength={8} maxLength={128}
          value={confirm} aria-invalid={mismatch} onChange={(e) => onConfirm(e.target.value)} />
        {mismatch && <p className="text-xs text-destructive">Passwords don't match.</p>}
      </div>
    </>
  );
}

function MissingLink({ title, action }: { title: string; action: ReactNode }) {
  return (
    <AuthShell title={title} description="This link is incomplete." footer={backToSignIn} allowSignedIn>
      <p role="alert" className="text-sm text-muted-foreground">Open the link from your email again, or copy all of it into the address bar. {action}</p>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const { api } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '');
  const request = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/forgot-password', { body: { email } })),
    meta: { inlineError: true },
  });

  return (
    <AuthShell title="Reset your password" description="We'll email you a link to choose a new one." footer={backToSignIn}>
      {request.isSuccess ? (
        <div role="status" className="grid gap-2 text-sm">
          <p>If an account exists for <span className="font-medium">{email}</span>, a reset link is on its way.</p>
          <p className="text-muted-foreground">It works once and expires in 60 minutes. Check your spam folder if it doesn't arrive.</p>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); request.mutate(); }}>
          <Field id="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <FormError error={request.error} />
          <Button type="submit" disabled={request.isPending}>{request.isPending ? 'Sending…' : 'Send reset link'}</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { api } = useAuth();
  const token = useLinkToken();
  const finish = useSignInAfterLink();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/reset-password', { body: { token: token!, password } })),
    onSuccess: (data) => finish(data.token, 'Password updated. You were signed out everywhere else.'),
    meta: { inlineError: true },
  });
  if (!token) return <MissingLink title="Reset your password" action={<Link className={linkClass} to="/forgot-password">Request a new link</Link>} />;

  return (
    <AuthShell title="Choose a new password" description="This signs you out on every other device." footer={backToSignIn} allowSignedIn>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (password === confirm) reset.mutate(); }}>
        <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        <FormError error={reset.error} />
        {reset.error ? <Link className={`${linkClass} text-sm`} to="/forgot-password">Request a new link</Link> : null}
        <Button type="submit" disabled={reset.isPending || password !== confirm}>{reset.isPending ? 'Saving…' : 'Set password and sign in'}</Button>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitationPage() {
  const { api } = useAuth();
  const token = useLinkToken();
  const finish = useSignInAfterLink();
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => unwrap(api.POST('/auth/invitations/lookup', { body: { token: token! } })),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });
  const accept = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/invitations/accept', { body: { token: token!, password, name: name?.trim() || undefined } })),
    onSuccess: (data) => finish(data.token, `Welcome to ${invitation.data?.organizationName ?? 'the team'}!`),
    meta: { inlineError: true },
  });
  if (!token) return <MissingLink title="Accept your invitation" action="Or ask your admin to resend it." />;

  if (invitation.isPending) {
    return <AuthShell title="Accept your invitation" description="Checking your invitation…" footer={backToSignIn} allowSignedIn><span aria-busy="true" /></AuthShell>;
  }
  if (invitation.isError) {
    return (
      <AuthShell title="Accept your invitation" description="We couldn't open this invitation." footer={backToSignIn} allowSignedIn>
        <div role="alert" className="grid gap-2 text-sm">
          <p className="text-destructive">{errorMessage(invitation.error)}</p>
          <p className="text-muted-foreground">Invitations expire after 7 days and work once. Ask your admin to resend it, or sign in if you already accepted.</p>
        </div>
      </AuthShell>
    );
  }

  const { email, organizationName, role } = invitation.data;
  return (
    <AuthShell title={`Join ${organizationName}`} description={`You're invited as ${role} with ${email}. Choose a password to get started.`}
      footer={backToSignIn} allowSignedIn>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (password === confirm) accept.mutate(); }}>
        <Field id="name" label="Your name" autoComplete="name" maxLength={200} value={name ?? invitation.data.name} onChange={(e) => setName(e.target.value)} />
        <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        <FormError error={accept.error} />
        <Button type="submit" disabled={accept.isPending || password !== confirm}>{accept.isPending ? 'Joining…' : `Join ${organizationName}`}</Button>
      </form>
    </AuthShell>
  );
}
