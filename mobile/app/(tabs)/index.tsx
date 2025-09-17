import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Button, ActivityIndicator, TouchableOpacity, ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiMe } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Link } from 'expo-router';

export default function TabOneScreen() {
  const { user, status } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isSmall = width <= 375;

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
    <ThemedView style={[styles.container, isSmall && { padding: 12 }] }>
      <ScrollView contentContainerStyle={{ paddingBottom: 12 + Math.max(insets.bottom, 12) }}>
        <ThemedText type="title">Dashboard</ThemedText>
        <ThemedText>Welcome{user?.displayName ? `, ${user.displayName}` : ''}!</ThemedText>
        <View style={[styles.row, isSmall && { gap: 10 }]}>
          <Card title="Spaces" href="/(tabs)/spaces" description="Switch spaces and windows" fullWidth={isSmall} />
          <Card title="Tasks" href="/(tabs)/tasks" description="Create and view tasks" fullWidth={isSmall} />
        </View>
        <View style={[styles.row, isSmall && { gap: 10 }]}>
          <Card title="Memories" href="/(tabs)/memories" description="Save and browse memories" fullWidth={isSmall} />
          <Card title="Chat" href="/(tabs)/control" description="Chat with the assistant" fullWidth={isSmall} />
        </View>
        <View style={[styles.rowSingle, isSmall && { gap: 10 }]}>
          <Card title="Settings" href="/(tabs)/settings" description="Manage Omi link and account" fullWidth={isSmall} />
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
  row: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  rowSingle: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  section: { gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

function Card({ title, description, href, fullWidth }: { title: string; description: string; href: string; fullWidth?: boolean }) {
  return (
    <Link href={href} asChild>
      <TouchableOpacity style={[cardStyles.card, fullWidth && { flexBasis: '100%' }]}>
        <Text style={cardStyles.title}>{title}</Text>
        <Text style={cardStyles.desc}>{description}</Text>
      </TouchableOpacity>
    </Link>
  );
}

const cardStyles = StyleSheet.create({
  card: { flexGrow: 1, flexBasis: '48%', padding: 14, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', borderRadius: 12, minHeight: 92 },
  title: { fontWeight: '700', fontSize: 16, marginBottom: 4 },
  desc: { color: '#666', fontSize: 13 },
});
