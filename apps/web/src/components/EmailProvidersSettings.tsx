import {useEffect, useState} from 'react';
import {EmailProviderType} from '@plunk/db';
import type {ProjectEmailProvider} from '@plunk/db';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  IconSpinner,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@plunk/ui';
import {AnimatePresence, motion} from 'framer-motion';
import {ArrowDown, ArrowUp, KeyRound, Mail, Server, Trash2} from 'lucide-react';
import {useProviders, useRemoveProvider, useUpsertProvider} from '../lib/hooks/useProviders';
import type {ProviderUpsertInput} from '../lib/hooks/useProviders';

const PROVIDER_LABELS: Record<EmailProviderType, string> = {
  [EmailProviderType.SES]: 'Amazon SES',
  [EmailProviderType.BREVO]: 'Brevo',
};

interface ProviderDraft {
  apiKey: string;
  dailyQuota: string;
  monthlyQuota: string;
}

function toInput(provider: ProjectEmailProvider, draft: ProviderDraft): ProviderUpsertInput {
  return {
    provider: provider.provider,
    enabled: provider.enabled,
    priority: provider.priority,
    apiKey: provider.provider === EmailProviderType.BREVO ? draft.apiKey || null : null,
    dailyQuota: draft.dailyQuota ? Number(draft.dailyQuota) : null,
    monthlyQuota: draft.monthlyQuota ? Number(draft.monthlyQuota) : null,
  };
}

function emptyDraft(): ProviderDraft {
  return {apiKey: '', dailyQuota: '', monthlyQuota: ''};
}

interface EmailProvidersSettingsProps {
  projectId: string;
}

export function EmailProvidersSettings({projectId}: EmailProvidersSettingsProps) {
  const {providers, mutate: mutateProviders, isLoading} = useProviders(projectId);
  const {upsert} = useUpsertProvider();
  const {remove} = useRemoveProvider();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [newProvider, setNewProvider] = useState<EmailProviderType>(EmailProviderType.SES);
  const [newDraft, setNewDraft] = useState<ProviderDraft>(emptyDraft());

  const [drafts, setDrafts] = useState<{[key: string]: ProviderDraft}>({});
  const [providerToRemove, setProviderToRemove] = useState<EmailProviderType | null>(null);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);

  // Seed per-row drafts from fetched providers
  useEffect(() => {
    if (providers) {
      const next: {[key: string]: ProviderDraft} = {};
      providers.forEach(p => {
        next[p.provider] = {
          apiKey: p.apiKey ?? '',
          dailyQuota: p.dailyQuota != null ? String(p.dailyQuota) : '',
          monthlyQuota: p.monthlyQuota != null ? String(p.monthlyQuota) : '',
        };
      });
      setDrafts(next);
    }
  }, [providers]);

  const showMessage = (type: 'success' | 'error', message: string) => {
    if (type === 'success') {
      setSuccessMessage(message);
      setErrorMessage(null);
      setTimeout(() => setSuccessMessage(null), 5000);
    } else {
      setErrorMessage(message);
      setSuccessMessage(null);
    }
  };

  const configuredProviders = (providers ?? []).map(p => p.provider);
  const availableProviders = Object.values(EmailProviderType).filter(
    p => !configuredProviders.includes(p),
  );

  const handleAdd = async () => {
    try {
      setIsSaving(true);
      setErrorMessage(null);
      await upsert(projectId, {
        provider: newProvider,
        enabled: true,
        priority: providers?.length ?? 0,
        apiKey: newProvider === EmailProviderType.BREVO ? newDraft.apiKey || null : null,
        dailyQuota: newDraft.dailyQuota ? Number(newDraft.dailyQuota) : null,
        monthlyQuota: newDraft.monthlyQuota ? Number(newDraft.monthlyQuota) : null,
      });
      await mutateProviders();
      setNewDraft(emptyDraft());
      const remaining = availableProviders.filter(p => p !== newProvider);
      if (remaining.length > 0) {
        setNewProvider(remaining[0]!);
      }
      showMessage('success', `Added ${PROVIDER_LABELS[newProvider]} as an email provider.`);
    } catch (error) {
      showMessage('error', error instanceof Error ? error.message : 'Couldn’t add the provider. Try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = async (provider: ProjectEmailProvider) => {
    try {
      await upsert(projectId, {...toInput(provider, drafts[provider.provider] ?? emptyDraft()), enabled: !provider.enabled});
      await mutateProviders();
    } catch (error) {
      showMessage('error', error instanceof Error ? error.message : 'Couldn’t update the provider. Try again.');
    }
  };

  const handleMove = async (provider: ProjectEmailProvider, direction: 'up' | 'down') => {
    if (!providers) return;
    const index = providers.findIndex(p => p.provider === provider.provider);
    if (index < 0) return;
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= providers.length) return;

    const current = providers[index]!;
    const other = providers[swapIndex]!;
    try {
      await upsert(projectId, {...toInput(current, drafts[current.provider] ?? emptyDraft()), priority: other.priority});
      await upsert(projectId, {...toInput(other, drafts[other.provider] ?? emptyDraft()), priority: current.priority});
      await mutateProviders();
    } catch (error) {
      showMessage('error', error instanceof Error ? error.message : 'Couldn’t reorder providers. Try again.');
    }
  };

  const handleSaveRow = async (provider: ProjectEmailProvider) => {
    try {
      setIsSaving(true);
      setErrorMessage(null);
      await upsert(projectId, toInput(provider, drafts[provider.provider] ?? emptyDraft()));
      await mutateProviders();
      showMessage('success', `Saved ${PROVIDER_LABELS[provider.provider]} settings.`);
    } catch (error) {
      showMessage('error', error instanceof Error ? error.message : 'Couldn’t save the provider. Try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!providerToRemove) return;
    try {
      await remove(projectId, providerToRemove);
      await mutateProviders();
      showMessage('success', `Removed ${PROVIDER_LABELS[providerToRemove]}.`);
    } catch (error) {
      showMessage('error', error instanceof Error ? error.message : 'Couldn’t remove the provider. Try again.');
    } finally {
      setProviderToRemove(null);
    }
  };

  const renderMessage = () => (
    <AnimatePresence mode="wait">
      {successMessage && (
        <motion.div
          initial={{opacity: 0, y: -10}}
          animate={{opacity: 1, y: 0}}
          exit={{opacity: 0}}
          className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800"
        >
          {successMessage}
        </motion.div>
      )}
      {errorMessage && (
        <motion.div
          initial={{opacity: 0, y: -10}}
          animate={{opacity: 1, y: 0}}
          exit={{opacity: 0}}
          className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
        >
          {errorMessage}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="space-y-6">
      {renderMessage()}

      {/* Add Provider */}
      <Card>
        <CardHeader>
          <CardTitle>Add email provider</CardTitle>
          <CardDescription>Configure the providers Plunk uses to send your email.</CardDescription>
        </CardHeader>
        <CardContent>
          {availableProviders.length === 0 ? (
            <p className="text-sm text-neutral-600">
              Both email providers are already configured. You can edit or remove them below.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select value={newProvider} onValueChange={value => setNewProvider(value as EmailProviderType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableProviders.map(p => (
                        <SelectItem key={p} value={p}>
                          {PROVIDER_LABELS[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {newProvider === EmailProviderType.BREVO && (
                  <>
                    <div className="space-y-2">
                      <Label>API key</Label>
                      <Input
                        type="password"
                        placeholder="xkeysib-…"
                        value={newDraft.apiKey}
                        onChange={e => setNewDraft(d => ({...d, apiKey: e.target.value}))}
                      />
                      <p className="text-xs text-neutral-500">Used to send through the Brevo API.</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Daily quota</Label>
                        <Input
                          type="number"
                          min={0}
                          placeholder="Unlimited"
                          value={newDraft.dailyQuota}
                          onChange={e => setNewDraft(d => ({...d, dailyQuota: e.target.value}))}
                        />
                        <p className="text-xs text-neutral-500">Emails per calendar day. Leave empty for unlimited.</p>
                      </div>
                      <div className="space-y-2">
                        <Label>Monthly quota</Label>
                        <Input
                          type="number"
                          min={0}
                          placeholder="Unlimited"
                          value={newDraft.monthlyQuota}
                          onChange={e => setNewDraft(d => ({...d, monthlyQuota: e.target.value}))}
                        />
                        <p className="text-xs text-neutral-500">Emails per calendar month. Leave empty for unlimited.</p>
                      </div>
                    </div>
                  </>
                )}

                {newProvider === EmailProviderType.SES && (
                  <p className="text-sm text-neutral-600">
                    Amazon SES uses your server’s AWS credentials — no API key needed here.
                  </p>
                )}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleAdd} disabled={isSaving}>
                  {isSaving ? 'Adding…' : 'Add provider'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Providers List */}
      <Card>
        <CardHeader>
          <CardTitle>Your providers</CardTitle>
          <CardDescription>
            Emails are sent using the top enabled provider, falling back down the list in order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <IconSpinner />
            </div>
          ) : !providers || providers.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No providers configured"
              description="Add an email provider above to start sending through Plunk."
            />
          ) : (
            <div className="space-y-4">
              {providers.map((provider, index) => {
                const draft = drafts[provider.provider] ?? emptyDraft();
                return (
                  <div key={provider.provider} className="border border-neutral-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        {provider.provider === EmailProviderType.SES ? (
                          <Server className="h-5 w-5 text-neutral-500" />
                        ) : (
                          <KeyRound className="h-5 w-5 text-neutral-500" />
                        )}
                        <div>
                          <h3 className="font-medium text-neutral-900">{PROVIDER_LABELS[provider.provider]}</h3>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline">Fallback #{index + 1}</Badge>
                            {provider.enabled ? (
                              <Badge variant="success">Enabled</Badge>
                            ) : (
                              <Badge variant="warning">Disabled</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMove(provider, 'up')}
                          disabled={index === 0}
                          aria-label="Move up"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleMove(provider, 'down')}
                          disabled={index === providers.length - 1}
                          aria-label="Move down"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructiveGhost"
                          size="sm"
                          onClick={() => {
                            setProviderToRemove(provider.provider);
                            setShowRemoveDialog(true);
                          }}
                          aria-label="Remove provider"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 py-3 border-t border-neutral-100">
                      <div>
                        <p className="text-sm font-medium text-neutral-900">
                          {provider.enabled ? 'Sending enabled' : 'Sending disabled'}
                        </p>
                        <p className="text-xs text-neutral-500">Turn off to stop using this provider.</p>
                      </div>
                      <Switch
                        checked={provider.enabled}
                        onCheckedChange={() => handleToggle(provider)}
                        aria-label={`Toggle ${PROVIDER_LABELS[provider.provider]}`}
                      />
                    </div>

                    <div className="pt-3 border-t border-neutral-100 space-y-3">
                      {provider.provider === EmailProviderType.BREVO && (
                        <div className="space-y-2">
                          <Label>API key</Label>
                          <Input
                            type="password"
                            placeholder="xkeysib-…"
                            value={draft.apiKey}
                            onChange={e =>
                              setDrafts(d => ({...d, [provider.provider]: {...draft, apiKey: e.target.value}}))
                            }
                          />
                        </div>
                      )}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Daily quota</Label>
                          <Input
                            type="number"
                            min={0}
                            placeholder="Unlimited"
                            value={draft.dailyQuota}
                            onChange={e =>
                              setDrafts(d => ({...d, [provider.provider]: {...draft, dailyQuota: e.target.value}}))
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Monthly quota</Label>
                          <Input
                            type="number"
                            min={0}
                            placeholder="Unlimited"
                            value={draft.monthlyQuota}
                            onChange={e =>
                              setDrafts(d => ({...d, [provider.provider]: {...draft, monthlyQuota: e.target.value}}))
                            }
                          />
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <Button variant="outline" size="sm" onClick={() => handleSaveRow(provider)} disabled={isSaving}>
                          {isSaving ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showRemoveDialog}
        onOpenChange={setShowRemoveDialog}
        onConfirm={handleRemove}
        title={providerToRemove ? `Remove ${PROVIDER_LABELS[providerToRemove]}?` : 'Remove provider?'}
        description="Plunk will stop sending through this provider until you add it again."
        confirmText="Remove provider"
        variant="destructive"
      />
    </div>
  );
}
