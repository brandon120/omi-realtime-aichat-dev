import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiMe, apiStartOmiLink, apiConfirmOmiLink, apiGetPreferences, apiUpdatePreferences, type Preferences } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export default function SettingsScreen() {
  const { logout } = useAuth();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isSmall = width <= 375;
  const [omiUserId, setOmiUserId] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [me, setMe] = useState<any>(null);
  const [devCode, setDevCode] = useState<string>('');
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState<boolean>(false);

  async function refreshProfile() {
    const data = await apiMe();
    setMe(data);
  }

  async function startLink() {
    try {
      const res = await apiStartOmiLink(omiUserId);
      setDevCode(res?.dev_code || '');
      Alert.alert('Link started', res?.dev_code ? `Dev code: ${res.dev_code}` : 'Check your Omi app for the code');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to start');
    }
  }

  async function confirmLink() {
    try {
      const ok = await apiConfirmOmiLink(omiUserId, code);
      if (ok) {
        Alert.alert('Linked');
        setCode('');
        setDevCode('');
        refreshProfile();
      } else {
        Alert.alert('Verification failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to confirm');
    }
  }

  useEffect(() => {
    (async () => {
      setPrefsLoading(true);
      const p = await apiGetPreferences();
      if (p) setPrefs(p);
      setPrefsLoading(false);
    })();
  }, []);

  return (
    <ThemedView style={[styles.container, isSmall && { padding: 12 }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 12 + Math.max(insets.bottom, 12) }}>
        <ThemedText type="title">Settings</ThemedText>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={[styles.rowButtons, isSmall && { gap: 6 }]}>
            <TouchableOpacity style={styles.primaryBtn} onPress={refreshProfile}><Text style={styles.btnText}>Refresh Profile</Text></TouchableOpacity>
            <TouchableOpacity style={styles.dangerBtn} onPress={logout}><Text style={styles.btnText}>Sign out</Text></TouchableOpacity>
          </View>
        </View>

        {me ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Profile</Text>
            <View style={{ borderWidth: 1, borderColor: '#eee', borderRadius: 8, padding: 8, backgroundColor: '#fafafa' }}>
              <Text selectable>{JSON.stringify(me, null, 2)}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Link Omi Account</Text>
          <View style={styles.field}>
            <Text style={styles.label}>Omi User ID</Text>
            <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={omiUserId} onChangeText={setOmiUserId} placeholder="omi_user_id" />
          </View>
          <View style={[styles.rowButtons, isSmall && { gap: 6 }]}>
            <TouchableOpacity style={styles.primaryBtn} onPress={startLink}><Text style={styles.btnText}>Start Linking</Text></TouchableOpacity>
          </View>
          {devCode ? <Text selectable style={{ marginTop: 6 }}>Dev Code: {devCode}</Text> : null}
          <View style={styles.field}>
            <Text style={styles.label}>Verification Code</Text>
            <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={code} onChangeText={setCode} placeholder="123456" />
          </View>
          <View style={[styles.rowButtons, isSmall && { gap: 6 }]}>
            <TouchableOpacity style={styles.successBtn} onPress={confirmLink}><Text style={styles.btnText}>Confirm Code</Text></TouchableOpacity>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>Preferences</Text>
        {prefsLoading ? (
          <Text>Loading preferences...</Text>
        ) : prefs ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>AI Behavior</Text>
              <View style={[styles.rowButtons, isSmall && { gap: 6 }]}>
                {(['TRIGGER','FOLLOWUP','ALWAYS'] as const).map((mode) => (
                  <TouchableOpacity key={mode} style={[styles.chip, prefs.listenMode===mode && styles.chipActive]} onPress={async ()=>{ const updated = await apiUpdatePreferences({ listenMode: mode }); if (updated) setPrefs(updated); }}>
                    <Text style={[styles.chipText, prefs.listenMode===mode && styles.chipTextActive]}>{mode}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={[styles.rowButtons, isSmall && { gap: 6 }]}>
                <TouchableOpacity style={[styles.chip, prefs.injectMemories && styles.chipActive]} onPress={async ()=>{ const updated = await apiUpdatePreferences({ injectMemories: !prefs.injectMemories }); if (updated) setPrefs(updated); }}>
                  <Text style={[styles.chipText, prefs.injectMemories && styles.chipTextActive]}>Memories</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.chip, prefs.meetingTranscribe && styles.chipActive]} onPress={async ()=>{ const updated = await apiUpdatePreferences({ meetingTranscribe: !prefs.meetingTranscribe }); if (updated) setPrefs(updated); }}>
                  <Text style={[styles.chipText, prefs.meetingTranscribe && styles.chipTextActive]}>Meeting Transcribe</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.chip, prefs.mute && styles.chipActive]} onPress={async ()=>{ const updated = await apiUpdatePreferences({ mute: !prefs.mute }); if (updated) setPrefs(updated); }}>
                  <Text style={[styles.chipText, prefs.mute && styles.chipTextActive]}>Mute</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Activation</Text>
              <View style={styles.field}>
                <Text style={styles.label}>Activation Regex</Text>
                <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={String(prefs.activationRegex || '')} onChangeText={async (v: string)=>{ const updated = await apiUpdatePreferences({ activationRegex: v }); if (updated) setPrefs(updated); }} placeholder="Custom regex (optional)" />
              </View>
              <View style={styles.rowButtons}>
                {([-2,-1,0,1,2] as const).map((s)=> (
                  <TouchableOpacity key={s} style={[styles.chip, (prefs.activationSensitivity||0)===s && styles.chipActive]} onPress={async ()=>{ const updated = await apiUpdatePreferences({ activationSensitivity: s }); if (updated) setPrefs(updated); }}>
                    <Text style={[styles.chipText, (prefs.activationSensitivity||0)===s && styles.chipTextActive]}>Sens {s}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Quiet Hours</Text>
              <View style={styles.rowHorizontal}>
                <View style={styles.fieldCol}>
                  <Text style={styles.label}>Start (HH:MM)</Text>
                  <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={String(prefs.dndQuietHoursStart || '')} onChangeText={async (v: string)=>{ const updated = await apiUpdatePreferences({ dndQuietHoursStart: v }); if (updated) setPrefs(updated); }} placeholder="22:00" />
                </View>
                <View style={styles.fieldCol}>
                  <Text style={styles.label}>End (HH:MM)</Text>
                  <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={String(prefs.dndQuietHoursEnd || '')} onChangeText={async (v: string)=>{ const updated = await apiUpdatePreferences({ dndQuietHoursEnd: v }); if (updated) setPrefs(updated); }} placeholder="07:00" />
                </View>
              </View>
            </View>
          </>
        ) : (
          <Text>Preferences unavailable.</Text>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { gap: 8 },
  rowHorizontal: { flexDirection: 'row', gap: 12 },
  field: { gap: 6 },
  fieldCol: { flex: 1 },
  label: { color: '#333' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowButtons: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: '#ccc', backgroundColor: '#fff' },
  chipActive: { backgroundColor: '#2f95dc', borderColor: '#2f95dc' },
  chipText: { color: '#333' },
  chipTextActive: { color: '#fff' },
  primaryBtn: { backgroundColor: '#2f95dc', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  successBtn: { backgroundColor: '#28a745', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  dangerBtn: { backgroundColor: '#dc3545', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '700' },
  card: { borderWidth: 1, borderColor: '#eee', backgroundColor: '#fff', borderRadius: 8, padding: 12, gap: 8 },
  sectionTitle: { fontWeight: '700', fontSize: 16 },
});

