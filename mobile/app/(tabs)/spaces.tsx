import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Button, Alert, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiGetSpaces, apiSwitchSpace, apiListWindows, apiActivateWindow } from '@/lib/api';

export default function SpacesScreen() {
  const [loading, setLoading] = useState<boolean>(false);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [activeSpace, setActiveSpace] = useState<string>('default');
  const [windows, setWindows] = useState<Array<{ slot: number; isActive: boolean; title?: string | null; summary?: string | null }>>([]);

  async function refresh() {
    setLoading(true);
    try {
      const s = await apiGetSpaces();
      if (s) {
        setActiveSpace(s.active);
        setSpaces(s.spaces);
      }
      const w = await apiListWindows();
      setWindows(w);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function onSwitchSpace(name: string) {
    const ok = await apiSwitchSpace(name);
    if (ok) {
      setActiveSpace(name);
      Alert.alert('Space switched', name);
    } else {
      Alert.alert('Failed to switch space');
    }
  }

  async function onActivateWindow(slot: number) {
    const ok = await apiActivateWindow(slot);
    if (ok) refresh();
    else Alert.alert('Failed to activate window');
  }

  useEffect(() => { refresh(); }, []);

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.headerRow}>
          <ThemedText type="title">Spaces</ThemedText>
          <Button title="Refresh" onPress={refresh} />
        </View>
        {loading ? <ActivityIndicator /> : null}
        <View style={styles.badgeRow}>
          {spaces.map((s: string) => (
            <TouchableOpacity key={s} style={[styles.badge, activeSpace === s && styles.badgeActive]} onPress={() => onSwitchSpace(s)}>
              <Text style={[styles.badgeText, activeSpace === s && styles.badgeTextActive]}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.section}>
          <ThemedText type="subtitle">Conversation Windows</ThemedText>
          {windows.map((w: { slot: number; isActive: boolean; title?: string | null; summary?: string | null }) => (
            <TouchableOpacity key={w.slot} style={[styles.windowItem, w.isActive && styles.windowItemActive]} onPress={() => onActivateWindow(w.slot)}>
              <Text style={styles.windowTitle}>{w.slot}) {w.title || '<empty>'}</Text>
              {w.summary ? <Text style={styles.windowSummary}>{w.summary}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#ccc', borderRadius: 999 },
  badgeActive: { backgroundColor: '#2f95dc', borderColor: '#2f95dc' },
  badgeText: { color: '#333' },
  badgeTextActive: { color: '#fff' },
  section: { gap: 8 },
  windowItem: { padding: 12, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, backgroundColor: '#fff' },
  windowItemActive: { borderColor: '#2f95dc' },
  windowTitle: { fontWeight: '600' },
  windowSummary: { color: '#666', marginTop: 4 },
});

