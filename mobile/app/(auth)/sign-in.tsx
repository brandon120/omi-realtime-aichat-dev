import React, { useState } from 'react';
import { StyleSheet, View, TextInput, Button, Alert } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';
import { Redirect, Link, useRouter } from 'expo-router';

export default function SignInScreen() {
  const { status, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  if (status === 'authenticated') return <Redirect href="/(tabs)" />;

  async function onSubmit() {
    if (!email || !password) return Alert.alert('Enter email and password');
    setLoading(true);
    const ok = await login(email, password);
    setLoading(false);
    if (!ok) {
      Alert.alert('Sign in failed');
      return;
    }
    // Ensure immediate navigation to the authenticated tabs
    router.replace('/(tabs)');
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Sign in</ThemedText>
      <View style={styles.form}>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry />
        <Button title={loading ? 'Signing in…' : 'Sign in'} onPress={onSubmit} />
      </View>
      <Link href="/(auth)/sign-up">Create account</Link>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, justifyContent: 'center', gap: 16 },
  form: { gap: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }
});

