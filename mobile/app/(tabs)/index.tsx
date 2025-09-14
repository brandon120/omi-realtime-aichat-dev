import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, Button, Alert } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiLogin, apiRegister, apiMe, apiLogout } from '@/lib/api';

export default function TabOneScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<any>(null);

  async function handleLogin() {
    try {
      const res = await apiLogin({ email, password });
      if (res) {
        Alert.alert('Logged in');
        const me = await apiMe();
        setProfile(me);
      } else {
        Alert.alert('Login failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Login failed');
    }
  }

  async function handleRegister() {
    try {
      const res = await apiRegister({ email, password });
      if (res) {
        Alert.alert('Registered');
        const me = await apiMe();
        setProfile(me);
      } else {
        Alert.alert('Register failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Register failed');
    }
  }

  async function handleLogout() {
    await apiLogout();
    setProfile(null);
    Alert.alert('Logged out');
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Welcome</ThemedText>
      <View style={styles.separator} />
      <View style={{ gap: 8, width: '100%', maxWidth: 420 }}>
        <Text>Email</Text>
        <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} placeholder="you@example.com" />
        <Text>Password</Text>
        <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} placeholder="••••••••" />
        <View style={{ height: 8 }} />
        <Button title="Login" onPress={handleLogin} />
        <View style={{ height: 8 }} />
        <Button title="Register" onPress={handleRegister} />
        <View style={{ height: 8 }} />
        <Button title="Logout" onPress={handleLogout} />
      </View>
      <View style={styles.separator} />
      <ThemedText type="subtitle">Me</ThemedText>
      <Text selectable>{JSON.stringify(profile, null, 2)}</Text>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 16 },
  separator: { marginVertical: 30, height: 1, width: '80%' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
});
