import React, { useState } from 'react';
import { StyleSheet, View, TextInput, Button, Alert } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';
import { Redirect, Link } from 'expo-router';

export default function SignUpScreen() {
  const { status, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  if (status === 'authenticated') return <Redirect href="/(tabs)" />;

  async function onSubmit() {
    if (!email || !password) return Alert.alert('Enter email and password');
    setLoading(true);
    const ok = await register(email, password, displayName || undefined);
    setLoading(false);
    if (!ok) Alert.alert('Sign up failed');
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Create account</ThemedText>
      <View style={styles.form}>
        <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} placeholder="Display name (optional)" />
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="•••••••• (min 8)" secureTextEntry />
        <Button title={loading ? 'Creating…' : 'Create account'} onPress={onSubmit} />
      </View>
      <Link href="/(auth)/sign-in">Have an account? Sign in</Link>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, justifyContent: 'center', gap: 16 },
  form: { gap: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }
});

