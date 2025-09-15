import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, FlatList, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiListMemories, apiCreateMemory, apiDeleteMemory, MemoryItem } from '@/lib/api';

export default function MemoriesScreen() {
  const [loading, setLoading] = useState<boolean>(false);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const listRef = useRef<FlatList<MemoryItem>>(null);

  async function load(initial = false) {
    setLoading(true);
    try {
      const res = await apiListMemories(50, initial ? undefined : cursor || undefined);
      if (initial) setItems(res.items);
      else setItems((prev: MemoryItem[]) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function addMemory() {
    if (!text.trim()) return;
    const ok = await apiCreateMemory(text.trim());
    if (ok) {
      setText('');
      load(true);
    } else {
      Alert.alert('Failed to create memory');
    }
  }

  async function deleteMemory(id: string) {
    const ok = await apiDeleteMemory(id);
    if (!ok) {
      Alert.alert('Failed to delete memory');
      return;
    }
    setItems((prev: MemoryItem[]) => prev.filter((m) => m.id !== id));
  }

  useEffect(() => { load(true); }, []);

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Memories</ThemedText>
      <View style={styles.row}>
        <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="Add a memory..." />
        <Button title="Save" onPress={addMemory} />
      </View>
      {loading && items.length === 0 ? <ActivityIndicator /> : null}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(m: MemoryItem) => m.id}
        renderItem={({ item }: { item: MemoryItem }) => {
          const rightActions = () => (
            <TouchableOpacity style={styles.deleteAction} onPress={() => deleteMemory(item.id)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          );
          return (
            <Swipeable renderRightActions={rightActions} overshootRight={false}>
              <View style={styles.card}>
                <Text style={styles.cardText}>{item.text}</Text>
                <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
            </Swipeable>
          );
        }}
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
  deleteAction: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#ff4d4f', paddingHorizontal: 16, borderRadius: 8, marginBottom: 8 },
  deleteText: { color: '#fff', fontWeight: '700' },
});

