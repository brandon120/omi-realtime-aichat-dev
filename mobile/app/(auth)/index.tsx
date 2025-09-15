import React from 'react';
import { View, StyleSheet, Text, Button } from 'react-native';
import { Link } from 'expo-router';
import { ThemedView, ThemedText } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';

export default function WelcomeScreen() {
  const { status } = useAuth();
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Welcome to Omi</ThemedText>
      <Text style={styles.subtitle}>Your agentic flow companion</Text>
      <View style={{ height: 20 }} />
      <Link href="/(auth)/sign-in" asChild>
        <Button title={status === 'loading' ? 'Loading…' : 'Sign in'} onPress={() => {}} />
      </Link>
      <View style={{ height: 12 }} />
      <Link href="/(auth)/sign-up" asChild>
        <Button title="Create account" onPress={() => {}} />
      </Link>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  subtitle: { color: '#666' }
});

