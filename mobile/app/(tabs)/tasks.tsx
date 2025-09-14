import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, FlatList, ActivityIndicator } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiListAgentEvents, apiCreateTask, AgentEventItem } from '@/lib/api';

export default function TasksScreen() {
  const [loading, setLoading] = useState<boolean>(false);
  const [items, setItems] = useState<AgentEventItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState<string>('');

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
    <ThemedView style={styles.container}>
      <ThemedText type="title">Tasks</ThemedText>
      <View style={styles.row}>
        <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="Add a task..." />
        <Button title="Add" onPress={addTask} />
      </View>
      {loading && items.length === 0 ? <ActivityIndicator /> : null}
      <FlatList
        data={items}
        keyExtractor={(m) => m.id}
        renderItem={({ item }: { item: AgentEventItem }) => (
          <View style={styles.card}>
            <Text style={styles.cardText}>{item.payload?.text || item.type}</Text>
            <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
          </View>
        )}
        ListFooterComponent={() => (
          cursor ? <Button title={loading ? 'Loading...' : 'Load more'} onPress={() => load(false)} /> : <Text style={styles.cardMeta}>No more</Text>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  card: { borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 8 },
  cardText: { fontSize: 16 },
  cardMeta: { color: '#666', marginTop: 6 },
});

