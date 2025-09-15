import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { ThemedView } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiListConversations,
  apiListMessages,
  apiSendMessage,
  apiCreateFollowup,
  apiSwitchSpace,
  apiActivateWindow,
  apiCreateMemory,
  apiCreateTask,
  apiMe,
  type ConversationItem,
  type MessageItem
} from '@/lib/api';

type ConversationState = {
  items: ConversationItem[];
  nextCursor: string | null;
  loading: boolean;
};

type MessageState = {
  byConversationId: Record<string, { items: MessageItem[]; nextCursor: string | null; loading: boolean }>
}

export default function ChatScreen() {
  const { user } = useAuth();
  const [convos, setConvos] = useState<ConversationState>({ items: [], nextCursor: null, loading: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageState>({ byConversationId: {} });
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const pollingRef = useRef<any>(null);
  const [hasOmiLink, setHasOmiLink] = useState<boolean>(true);

  const selectedMessages = useMemo(() => {
    if (!selectedId) return [] as MessageItem[];
    const entry = messages.byConversationId[selectedId];
    return (entry?.items || []).slice().sort((a: MessageItem, b: MessageItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [messages, selectedId]);

  async function loadConversations() {
    setConvos((prev: ConversationState) => ({ ...prev, loading: true }));
    const res = await apiListConversations(20);
    setConvos({ items: res.items, nextCursor: res.nextCursor, loading: false });
    if (!selectedId && res.items.length > 0) setSelectedId(res.items[0].id);
  }

  async function loadMessages(conversationId: string) {
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: prev.byConversationId[conversationId]?.items || [], nextCursor: prev.byConversationId[conversationId]?.nextCursor || null, loading: true }
      }
    }));
    const res = await apiListMessages(conversationId, 100);
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: res.items, nextCursor: res.nextCursor, loading: false }
      }
    }));
  }

  useEffect(() => { 
    loadConversations();
    (async () => {
      const me = await apiMe();
      const verified = (me?.omi_links || []).some((l: any) => l.isVerified);
      setHasOmiLink(!!verified);
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId);
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      loadMessages(selectedId);
    }, 3000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [selectedId]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!selectedId) return;
    setSending(true);

    // Slash commands
    if (text.startsWith('/')) {
      const cmd = text.slice(1).trim();
      if (cmd.startsWith('notify ')) {
        const ok = await apiCreateFollowup({ conversation_id: selectedId, message: cmd.slice('notify '.length) });
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('space ')) {
        await apiSwitchSpace(cmd.slice('space '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('window ')) {
        const num = parseInt(cmd.slice('window '.length).trim(), 10);
        if (!isNaN(num)) await apiActivateWindow(num);
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('mem ')) {
        await apiCreateMemory(cmd.slice('mem '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('task ')) {
        await apiCreateTask(cmd.slice('task '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
    }

    // Optimistic add user message
    const optimistic: MessageItem = {
      id: `local-${Date.now()}`,
      role: 'USER',
      text,
      source: 'FRONTEND',
      createdAt: new Date().toISOString()
    };
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [selectedId]: {
          items: [...(prev.byConversationId[selectedId]?.items || []), optimistic],
          nextCursor: prev.byConversationId[selectedId]?.nextCursor || null,
          loading: false
        }
      }
    }));
    setInput('');

    const res = await apiSendMessage({ conversation_id: selectedId, text });
    setSending(false);
    if (!res) return;
    // Refresh messages to include assistant response
    await loadMessages(selectedId);
  }, [input, sending, selectedId]);

  const renderConversation = ({ item }: { item: ConversationItem }) => {
    const active = item.id === selectedId;
    return (
      <TouchableOpacity style={[styles.conversationItem, active && styles.conversationItemActive]} onPress={() => setSelectedId(item.id)}>
        <Text style={styles.conversationTitle}>{item.title || 'Untitled'}</Text>
        {item.summary ? <Text style={styles.conversationSummary} numberOfLines={1}>{item.summary}</Text> : null}
      </TouchableOpacity>
    );
  };

  const renderMessage = ({ item }: { item: MessageItem }) => {
    const isAssistant = item.role === 'ASSISTANT';
    return (
      <View style={[styles.bubbleRow, isAssistant ? styles.left : styles.right]}>
        <View style={[styles.bubble, isAssistant ? styles.assistantBubble : styles.userBubble]}>
          <Text style={isAssistant ? styles.assistantText : styles.userText}>{item.text}</Text>
        </View>
      </View>
    );
  };

  const selectedLoading = selectedId ? messages.byConversationId[selectedId]?.loading : false;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.container}>
        <View style={styles.sidebar}>
          <View style={styles.sidebarHeader}>
            <Text style={{ fontSize: 22, fontWeight: '800' }}>Chat</Text>
          </View>
          {convos.loading ? <ActivityIndicator /> : (
            <FlatList<ConversationItem>
              data={convos.items}
              renderItem={renderConversation}
              keyExtractor={(c: ConversationItem) => c.id}
            />
          )}
        </View>

        <View style={styles.chatArea}>
          {!hasOmiLink ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>Tip: Link your OMI account in Settings to receive live notifications.</Text>
            </View>
          ) : null}
          {!selectedId ? (
            <View style={styles.emptyState}>
              <Text>Select a conversation</Text>
            </View>
          ) : (
            <>
              <FlatList<MessageItem>
                style={styles.messageList}
                contentContainerStyle={{ padding: 12 }}
                data={selectedMessages}
                renderItem={renderMessage}
                keyExtractor={(m: MessageItem) => m.id}
              />
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.textInput}
                  placeholder="Type a message or /notify ..."
                  value={input}
                  onChangeText={setInput}
                  multiline
                />
                <TouchableOpacity style={styles.sendBtn} onPress={onSend} disabled={sending || !input.trim()}>
                  <Text style={styles.sendBtnText}>{sending ? '...' : 'Send'}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 240, borderRightWidth: 1, borderRightColor: '#eee', padding: 12, gap: 12 },
  sidebarHeader: { paddingBottom: 8 },
  conversationItem: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  conversationItemActive: { backgroundColor: '#f2f2f2' },
  conversationTitle: { fontWeight: '700' },
  conversationSummary: { color: '#666' },
  chatArea: { flex: 1, paddingTop: 12 },
  banner: { marginHorizontal: 12, marginBottom: 8, padding: 10, backgroundColor: '#fff7e6', borderColor: '#ffd591', borderWidth: 1, borderRadius: 8 },
  bannerText: { color: '#8c6d1f' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { flex: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  textInput: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sendBtn: { backgroundColor: '#007bff', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  sendBtnText: { color: '#fff', fontWeight: '700' },
  bubbleRow: { width: '100%', marginVertical: 4, paddingHorizontal: 8 },
  left: { alignItems: 'flex-start' },
  right: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  assistantBubble: { backgroundColor: '#f0f0f0', borderTopLeftRadius: 2 },
  userBubble: { backgroundColor: '#007bff', borderTopRightRadius: 2 },
  assistantText: { color: '#333' },
  userText: { color: '#fff' },
});

