import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Button, ActivityIndicator, TouchableOpacity, ScrollView } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiMe } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Link } from 'expo-router';

export default function TabOneScreen() {
  const { user, status } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);

  async function refresh() {
    setLoading(true);
    try {
      const data = await apiMe();
      setMe(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <ThemedText type="title">Dashboard</ThemedText>
        <ThemedText>Welcome{user?.displayName ? `, ${user.displayName}` : ''}!</ThemedText>
        <View style={styles.row}>
          <Card title="Spaces" href="/(tabs)/spaces" description="Switch spaces and windows" />
          <Card title="Tasks" href="/(tabs)/tasks" description="Create and view tasks" />
        </View>
        <View style={styles.row}>
          <Card title="Memories" href="/(tabs)/memories" description="Save and browse memories" />
          <Card title="Control" href="/(tabs)/control" description="Send messages to assistant" />
        </View>
        <View style={styles.rowSingle}>
          <Card title="Settings" href="/(tabs)/settings" description="Manage Omi link and account" />
        </View>
        <View style={styles.section}>
          <View style={styles.headerRow}>
            <ThemedText type="subtitle">Profile</ThemedText>
            <Button title={loading ? 'Loading…' : 'Refresh'} onPress={refresh} />
          </View>
          {status === 'loading' || loading ? <ActivityIndicator /> : null}
          <Text selectable>{JSON.stringify(me?.user || user, null, 2)}</Text>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  rowSingle: { flexDirection: 'row', gap: 12 },
  section: { gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

function Card({ title, description, href }: { title: string; description: string; href: string }) {
  return (
    <Link href={href} asChild>
      <TouchableOpacity style={cardStyles.card}>
        <Text style={cardStyles.title}>{title}</Text>
        <Text style={cardStyles.desc}>{description}</Text>
      </TouchableOpacity>
    </Link>
  );
}

const cardStyles = StyleSheet.create({
  card: { flex: 1, padding: 16, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', borderRadius: 12, minHeight: 100 },
  title: { fontWeight: '700', fontSize: 16, marginBottom: 6 },
  desc: { color: '#666' },
});
