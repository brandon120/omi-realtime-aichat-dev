import React, { useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, ScrollView, TouchableOpacity } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiMe, apiStartOmiLink, apiConfirmOmiLink } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export default function SettingsScreen() {
  const { logout } = useAuth();
  const [omiUserId, setOmiUserId] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [me, setMe] = useState<any>(null);
  const [devCode, setDevCode] = useState<string>('');

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

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <ThemedText type="title">Settings</ThemedText>
        <View style={styles.rowButtons}>
          <TouchableOpacity style={styles.primaryBtn} onPress={refreshProfile}><Text style={styles.btnText}>Refresh Profile</Text></TouchableOpacity>
          <TouchableOpacity style={styles.dangerBtn} onPress={logout}><Text style={styles.btnText}>Sign out</Text></TouchableOpacity>
        </View>
        {me ? (
          <View style={styles.card}>
            <Text selectable>{JSON.stringify(me, null, 2)}</Text>
          </View>
        ) : null}
        <View style={{ height: 16 }} />
        <ThemedText type="subtitle">Link Omi Account</ThemedText>
        <View style={styles.row}>
          <Text>Omi User ID</Text>
          <TextInput style={styles.input} value={omiUserId} onChangeText={setOmiUserId} placeholder="omi_user_id" />
        </View>
        <TouchableOpacity style={styles.primaryBtn} onPress={startLink}><Text style={styles.btnText}>Start Linking</Text></TouchableOpacity>
        {devCode ? <Text selectable style={{ marginTop: 6 }}>Dev Code: {devCode}</Text> : null}
        <View style={styles.row}>
          <Text>Verification Code</Text>
          <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="123456" />
        </View>
        <TouchableOpacity style={styles.successBtn} onPress={confirmLink}><Text style={styles.btnText}>Confirm Code</Text></TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowButtons: { flexDirection: 'row', gap: 8 },
  primaryBtn: { backgroundColor: '#2f95dc', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  successBtn: { backgroundColor: '#28a745', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  dangerBtn: { backgroundColor: '#dc3545', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '700' },
  card: { borderWidth: 1, borderColor: '#eee', backgroundColor: '#fff', borderRadius: 8, padding: 12 },
});

