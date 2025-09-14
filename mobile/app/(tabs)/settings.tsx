import React, { useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiMe, apiStartOmiLink, apiConfirmOmiLink } from '@/lib/api';

export default function SettingsScreen() {
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
      <ThemedText type="title">Settings</ThemedText>
      <Button title="Refresh Profile" onPress={refreshProfile} />
      <Text selectable>{JSON.stringify(me, null, 2)}</Text>
      <View style={{ height: 16 }} />
      <ThemedText type="subtitle">Link Omi Account</ThemedText>
      <View style={styles.row}>
        <Text>Omi User ID</Text>
        <TextInput style={styles.input} value={omiUserId} onChangeText={setOmiUserId} placeholder="omi_user_id" />
      </View>
      <Button title="Start Linking" onPress={startLink} />
      {devCode ? <Text selectable>Dev Code: {devCode}</Text> : null}
      <View style={styles.row}>
        <Text>Verification Code</Text>
        <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="123456" />
      </View>
      <Button title="Confirm Code" onPress={confirmLink} />
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
});

