'use client';

import { Card, CardContent, CardHeader } from '@/components/ui';
import { Settings, RefreshCw, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface ServiceStatus {
  name: string;
  status: 'checking' | 'connected' | 'configured' | 'disconnected' | 'not_configured';
  detail?: string;
}

export default function SettingsPage() {
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: 'Supabase Database', status: 'checking' },
    { name: 'Google Vision API', status: 'checking' },
    { name: 'Supabase Storage', status: 'checking' },
    { name: 'n8n Workflow Engine', status: 'checking' },
    { name: 'Email (IMAP)', status: 'checking' },
    { name: 'WhatsApp (Twilio)', status: 'checking' },
    { name: 'Silo WMS', status: 'checking' },
    { name: 'Google Drive', status: 'checking' },
  ]);
  const [checking, setChecking] = useState(false);

  const checkAll = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/settings/status');
      if (res.ok) {
        const data: ServiceStatus[] = await res.json();
        setServices(data);
      }
    } catch {
      // keep existing state
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkAll();
  }, [checkAll]);

  function getStatusBadge(status: ServiceStatus['status']) {
    switch (status) {
      case 'connected':
        return { cls: 'bg-green-100 text-green-700', icon: CheckCircle, label: 'Connected' };
      case 'configured':
        return { cls: 'bg-blue-100 text-blue-700', icon: CheckCircle, label: 'Configured' };
      case 'disconnected':
        return { cls: 'bg-red-100 text-red-700', icon: XCircle, label: 'Disconnected' };
      case 'not_configured':
        return { cls: 'bg-yellow-100 text-yellow-700', icon: AlertCircle, label: 'Not Configured' };
      default:
        return { cls: 'bg-slate-100 text-slate-500', icon: RefreshCw, label: 'Checking...' };
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>

      <Card>
        <CardHeader>
          <h3 className="font-semibold text-slate-900">System Configuration</h3>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <h4 className="font-medium text-slate-700">Processing Settings</h4>
              <div className="text-sm text-slate-500 space-y-1">
                <p>OCR Engine: Google Vision API</p>
                <p>Max concurrent processing: 5</p>
                <p>Auto-retry on failure: 3 attempts</p>
                <p>Processing timeout: 60 seconds</p>
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium text-slate-700">Silo WMS Integration</h4>
              <div className="text-sm text-slate-500 space-y-1">
                <p>Export method: CSV File</p>
                <p>Export schedule: Every 30 minutes</p>
                <p>File format: [TYPE]_YYYYMMDD_HHMMSS.csv</p>
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium text-slate-700">Business Rules</h4>
              <div className="text-sm text-slate-500 space-y-1">
                <p>High-value order threshold: $10,000</p>
                <p>Price variance alert: &gt;10%</p>
                <p>New customer: Requires manual approval</p>
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium text-slate-700">Notifications</h4>
              <div className="text-sm text-slate-500 space-y-1">
                <p>Exception alerts: Email</p>
                <p>Daily summary: 8:00 PM EST</p>
                <p>Critical failures: Immediate</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-900">Connected Services</h3>
            <button
              onClick={checkAll}
              disabled={checking}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Checking...' : 'Refresh Status'}
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {services.map((service) => {
              const badge = getStatusBadge(service.status);
              const Icon = badge.icon;
              return (
                <div key={service.name} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div>
                    <span className="text-sm font-medium text-slate-700">{service.name}</span>
                    {service.detail && (
                      <p className="text-xs text-slate-500 mt-0.5">{service.detail}</p>
                    )}
                  </div>
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${badge.cls}`}>
                    <Icon className="w-3 h-3" />
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
