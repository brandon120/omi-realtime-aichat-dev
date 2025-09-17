import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, FlatList, ActivityIndicator, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiListAgentEvents, apiCreateTask, apiCompleteTask, AgentEventItem } from '@/lib/api';

export default function TasksScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isSmall = width <= 375;
  const [loading, setLoading] = useState<boolean>(false);
  const [items, setItems] = useState<AgentEventItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const active = useMemo(() => items.filter((i) => !(i.payload && i.payload.done)), [items]);
  const completed = useMemo(() => items.filter((i) => i.payload && i.payload.done), [items]);

  async function load(initial = false) {
    setLoading(true);
    try {
      const res = await apiListAgentEvents(50, initial ? undefined : cursor || undefined);
      if (initial) setItems(res.items);
      else setItems((prev: AgentEventItem[]) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function addTask() {
    if (!text.trim()) return;
    const ok = await apiCreateTask(text.trim());
    if (ok) {
      setText('');
      load(true);
    } else {
      Alert.alert('Failed to add task');
    }
  }

  useEffect(() => { load(true); }, []);

  return (
    <ThemedView style={[styles.container, isSmall && { padding: 12 }]}>
      <ThemedText type="title">Tasks</ThemedText>
      <View style={[styles.row, isSmall && { gap: 6 }]}>
        <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={text} onChangeText={setText} placeholder="Add a task..." />
        <Button title="Add" onPress={addTask} />
      </View>
      {loading && items.length === 0 ? <ActivityIndicator /> : null}
      <FlatList
        data={active}
        keyExtractor={(m: AgentEventItem) => m.id}
        renderItem={({ item }: { item: AgentEventItem }) => (
          <View style={styles.card}>
            <View style={styles.cardRow}>
              <TouchableOpacity
                style={[styles.check, item.payload?.done && styles.checkOn]}
                onPress={async () => {
                  const ok = await apiCompleteTask(item.id);
                  if (!ok) return Alert.alert('Failed to complete task');
                  setItems((prev: AgentEventItem[]) => prev.map((t) => t.id === item.id ? { ...t, payload: { ...(t.payload || {}), done: true, completedAt: new Date().toISOString() } } : t));
                }}
              >
                <Text style={styles.checkText}>{item.payload?.done ? '✓' : ''}</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardText}>{item.payload?.text || item.type}</Text>
                <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
            </View>
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 12 + Math.max(insets.bottom, 8) }}
        ListFooterComponent={() => (
          cursor ? <Button title={loading ? 'Loading...' : 'Load more'} onPress={() => load(false)} /> : <Text style={styles.cardMeta}>No more</Text>
        )}
      />
      {completed.length > 0 ? (
        <View style={{ marginTop: 16 }}>
          <ThemedText type="subtitle">Completed</ThemedText>
          <FlatList
            data={completed}
            keyExtractor={(m: AgentEventItem) => m.id}
            renderItem={({ item }: { item: AgentEventItem }) => (
              <View style={[styles.card, styles.cardCompleted]}>
                <View style={styles.cardRow}>
                  <View style={[styles.check, styles.checkOn]}><Text style={styles.checkText}>✓</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardText, styles.completedText]}>{item.payload?.text || item.type}</Text>
                    <Text style={styles.cardMeta}>{new Date(item.payload?.completedAt || item.createdAt).toLocaleString()}</Text>
                  </View>
                </View>
              </View>
            )}
          />
        </View>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  card: { borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 8 },
  cardCompleted: { opacity: 0.7 },
  cardText: { fontSize: 16 },
  cardMeta: { color: '#666', marginTop: 6 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#2f95dc', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#2f95dc' },
  checkText: { color: '#fff', fontWeight: '700' },
  completedText: { textDecorationLine: 'line-through' },
});

